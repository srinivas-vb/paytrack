import { Router } from 'express';

import { query } from '../db.js';
import { requireWorker } from '../lib/worker.js';

const router = Router();

// Every workplace route is scoped to a single worker. The employer never reads
// or writes here, and one worker must never see another's saved locations, so
// identity is resolved before any handler runs and every query is filtered by
// worker_id -- never by id alone.
router.use(requireWorker);

const LABEL_MAX = 100;

/**
 * Maps a workplaces row to the Workplace shape in docs/contracts.md.
 *
 * `id` is BIGSERIAL, which node-pg hands back as a string to avoid silently
 * losing precision past 2^53. The contract says number, and a hackathon-scale
 * id is nowhere near that ceiling, so narrow it here at the boundary rather
 * than leaking a stringly-typed id into the API.
 */
function toWorkplace(row) {
  return {
    id: Number(row.id),
    label: row.label,
    lat: row.lat,
    lng: row.lng,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Validates a POST body against the contract.
 *
 * Returns `{ error }` with a message naming the offending field, or `{ value }`
 * with the cleaned input. Never throws.
 *
 * Note the shape of the numeric checks. `typeof x === 'number'` is true for
 * NaN, and `NaN >= -90 && NaN <= 90` is false, so a bare range test happens to
 * reject it -- but only by accident, and Infinity would slip through a
 * carelessly written one. Number.isFinite() states the intent directly: a
 * coordinate must be a real, finite number.
 */
function validateBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'body must be a JSON object' };
  }

  const { label, lat, lng } = body;

  if (label === undefined || label === null) {
    return { error: 'label is required' };
  }
  if (typeof label !== 'string') {
    return { error: 'label must be a string' };
  }

  const trimmed = label.trim();
  if (trimmed.length === 0) {
    return { error: 'label must be 1-100 characters' };
  }
  if (trimmed.length > LABEL_MAX) {
    return { error: `label must be 1-${LABEL_MAX} characters` };
  }

  for (const [name, value] of [
    ['lat', lat],
    ['lng', lng],
  ]) {
    if (value === undefined || value === null) {
      return { error: `${name} is required` };
    }
    // Strings are rejected on purpose: the contract says these are JSON
    // numbers, and coercing "abc" -> NaN here would turn a client bug into a
    // confusing range error instead of a clear type error.
    if (typeof value !== 'number') {
      return { error: `${name} must be a number` };
    }
    if (!Number.isFinite(value)) {
      return { error: `${name} must be a finite number` };
    }
  }

  if (lat < -90 || lat > 90) {
    return { error: 'lat must be between -90 and 90' };
  }
  if (lng < -180 || lng > 180) {
    return { error: 'lng must be between -180 and 180' };
  }

  return { value: { label: trimmed, lat, lng } };
}

/**
 * Parses `:id`. Anything that is not a positive integer cannot be a row we own,
 * so it is reported as 404 rather than 400 -- same answer a client gets for a
 * real id belonging to somebody else, which is the point.
 */
function parseId(raw) {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// ---------------------------------------------------------------------------
// GET /api/workplaces
// ---------------------------------------------------------------------------
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, label, lat, lng, created_at
         FROM workplaces
        WHERE worker_id = $1 AND deleted_at IS NULL
        ORDER BY created_at ASC, id ASC`,
      [req.workerId]
    );

    res.json({ workplaces: rows.map(toWorkplace) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/workplaces
// ---------------------------------------------------------------------------
router.post('/', async (req, res, next) => {
  const { error, value } = validateBody(req.body);
  if (error) return res.status(400).json({ error });

  try {
    // created_at is left to the column default. Server time only -- a client
    // must never be able to backdate a record in this system.
    const { rows } = await query(
      `INSERT INTO workplaces (worker_id, label, lat, lng)
       VALUES ($1, $2, $3, $4)
       RETURNING id, label, lat, lng, created_at`,
      [req.workerId, value.label, value.lat, value.lng]
    );

    res.status(201).json({ workplace: toWorkplace(rows[0]) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/workplaces/:id
//
// Soft delete. hours_log.workplace_id references workplaces(id), so a workplace
// any shift has ever used cannot be physically removed -- the evidence ledger
// must keep resolving the label it was recorded against. A deletion today must
// never reach backwards and edit history.
//
// Rather than branch on whether a row happens to be referenced, every delete
// takes the same path: stamp deleted_at, filter it out of GET. One code path,
// one behaviour, and "hidden from the worker but still resolvable for history"
// is named directly instead of being encoded in some other column.
//
// ON DELETE SET NULL on the FK would be the wrong fix -- it rewrites hours_log
// rows, which is precisely what an append-only ledger exists to prevent.
// ---------------------------------------------------------------------------
router.delete('/:id', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(404).json({ error: 'not found' });

  try {
    const { rowCount } = await query(
      `UPDATE workplaces
          SET deleted_at = now()
        WHERE id = $1 AND worker_id = $2 AND deleted_at IS NULL`,
      [id, req.workerId]
    );

    // Zero rows means the id does not exist, belongs to another worker, or is
    // already deleted. All three answer identically and deliberately: a 403
    // would confirm to a stranger that the row exists.
    if (rowCount === 0) return res.status(404).json({ error: 'not found' });

    return res.status(204).end();
  } catch (err) {
    return next(err);
  }
});

export default router;
