/**
 * /api/shifts -- the append-only evidence ledger surface.
 *
 * Everything here obeys docs/contracts.md. Three properties are load-bearing:
 *
 *   1. hours_log is APPEND-ONLY (a Postgres trigger rejects UPDATE/DELETE), so
 *      clock-out cannot close the open row. It writes a NEW entry carrying the
 *      same clock_in plus a clock_out, and the later entry supersedes the
 *      earlier one. GET / collapses those pairs so the UI sees one shift.
 *
 *   2. Appends are ATOMIC per worker. Reading the chain head and inserting the
 *      next entry happen inside one transaction guarded by a per-worker
 *      advisory lock, so two fast taps cannot both chain off the same prevHash
 *      and fork the chain. An advisory lock rather than SELECT ... FOR UPDATE
 *      because the first entry for a worker has no row to lock.
 *
 *   3. created_at is server-generated (column DEFAULT now()). It is never read
 *      from the request body -- it is the field that makes a record
 *      contemporaneous, and a client-settable one would be worthless.
 */
import { Router } from 'express';

import { pool } from '../db.js';
import { computeEntryHash, verifyChain, GENESIS_HASH } from '../lib/hash.js';
import { nearestWorkplace } from '../lib/geo.js';
import { requireWorker } from '../lib/worker.js';

const router = Router();

// Every route below is worker-scoped. Applying it here keeps the router
// self-contained regardless of how it is mounted.
router.use(requireWorker);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Thrown to abort a transaction with a specific HTTP response. */
class HttpError extends Error {
  constructor(status, body) {
    super(body?.error || `http ${status}`);
    this.status = status;
    this.body = body;
  }
}

function sendError(err, res, next) {
  if (err instanceof HttpError) return res.status(err.status).json(err.body);
  return next(err);
}

const toIso = (v) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

const num = (v) => (v === null || v === undefined ? null : Number(v));

/**
 * Accepts a GPS reading only if it is fully well-formed. Anything else is
 * treated as "no reading", never as an error: per lib/geo.js the stance is that
 * location is corroboration, and a bad fix must not block a worker from
 * recording their hours.
 */
function sanitizeGps(gps) {
  if (!gps || typeof gps !== 'object') return null;
  const lat = Number(gps.lat);
  const lng = Number(gps.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

/** DB row (optionally carrying workplace_label) -> the Shift shape in the contract. */
function rowToShift(row) {
  return {
    id: Number(row.id),
    workplaceId: row.workplace_id === null || row.workplace_id === undefined
      ? null
      : Number(row.workplace_id),
    workplaceLabel: row.workplace_label ?? null,
    clockIn: toIso(row.clock_in),
    clockOut: row.clock_out === null || row.clock_out === undefined ? null : toIso(row.clock_out),
    gpsLat: num(row.gps_lat),
    gpsLng: num(row.gps_lng),
    distanceM: num(row.distance_m),
    offsiteFlag: Boolean(row.offsite_flag),
    isRetroactive: Boolean(row.is_retroactive),
    prevHash: row.prev_hash ?? GENESIS_HASH,
    entryHash: row.entry_hash,
    createdAt: toIso(row.created_at),
  };
}

const ENTRY_SELECT = `
  SELECT h.id,
         h.workplace_id,
         w.label AS workplace_label,
         h.clock_in,
         h.clock_out,
         h.gps_lat,
         h.gps_lng,
         h.distance_m,
         h.offsite_flag,
         h.is_retroactive,
         h.prev_hash,
         h.entry_hash,
         h.created_at
    FROM hours_log h
    LEFT JOIN workplaces w ON w.id = h.workplace_id
   WHERE h.worker_id = $1
   ORDER BY h.id ASC
`;

/** The worker's whole chain, oldest first (insertion order == chain order). */
async function loadEntries(db, workerId) {
  const { rows } = await db.query(ENTRY_SELECT, [workerId]);
  return rows.map(rowToShift);
}

/**
 * Workplaces eligible to match a NEW clock-in.
 *
 * Excludes soft-deleted rows: a worker who deleted a workplace should not keep
 * being geofenced to it. Note the deliberate asymmetry with ENTRY_SELECT above,
 * which joins workplaces WITHOUT this filter -- past shifts must keep resolving
 * the label they were recorded against, even after the workplace is deleted.
 * Hiding a location from future matching and erasing it from history are
 * different operations, and only the first one is what delete means here.
 */
async function loadWorkplaces(db, workerId) {
  const { rows } = await db.query(
    'SELECT id, label, lat, lng FROM workplaces WHERE worker_id = $1 AND deleted_at IS NULL',
    [workerId]
  );
  return rows.map((r) => ({
    id: Number(r.id),
    label: r.label,
    lat: num(r.lat),
    lng: num(r.lng),
  }));
}

/**
 * Collapses supersession pairs.
 *
 * Clock-out appends a second entry with the SAME clock_in plus a clock_out.
 * Entries are therefore grouped by clock_in; within a group the completed
 * entry wins (and, among completed ones, the latest). The surviving entry is
 * shown whole -- its own id, prevHash and entryHash -- so that the hash the UI
 * displays actually covers the clockIn/clockOut it is displayed next to.
 *
 * @param {Array} entries oldest first
 * @returns {Array} one shift per real-world shift, oldest first
 */
function collapse(entries) {
  const byClockIn = new Map();

  for (const e of entries) {
    const prior = byClockIn.get(e.clockIn);
    if (!prior) {
      byClockIn.set(e.clockIn, e);
      continue;
    }
    // A later entry supersedes an earlier one when it closes the shift, or
    // when both are still open (a duplicate open entry -- keep the newest).
    if (e.clockOut !== null || prior.clockOut === null) byClockIn.set(e.clockIn, e);
  }

  return [...byClockIn.values()];
}

/** The open shift: the newest collapsed entry still lacking a clock_out. */
function findOpenShift(collapsed) {
  let open = null;
  for (const s of collapsed) {
    if (s.clockOut === null && (open === null || s.id > open.id)) open = s;
  }
  return open;
}

/** Newest first: by claimed shift start, falling back to insertion order. */
function newestFirst(a, b) {
  const diff = Date.parse(b.clockIn) - Date.parse(a.clockIn);
  return diff !== 0 ? diff : b.id - a.id;
}

// ---------------------------------------------------------------------------
// Atomic chain append
// ---------------------------------------------------------------------------

/**
 * Runs `fn` inside a transaction holding this worker's advisory lock, with the
 * worker's whole chain already read under that lock. Whatever `fn` inserts is
 * guaranteed to be chained off a head nobody else can be appending to
 * concurrently.
 *
 * The lock is transaction-scoped, so it is released by COMMIT or ROLLBACK even
 * if the process dies mid-request.
 */
async function withChainLock(workerId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [workerId]);

    const entries = await loadEntries(client, workerId);
    const head = entries.length ? entries[entries.length - 1] : null;

    const result = await fn({
      client,
      entries,
      prevHash: head ? head.entryHash : GENESIS_HASH,
    });

    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Writes one ledger entry. The hash is computed from exactly the values being
 * stored, in the canonical order lib/hash.js defines -- never recomputed
 * elsewhere, never from post-read values.
 *
 * created_at is omitted deliberately: the column default (now()) supplies it.
 */
async function insertEntry(client, workerId, entry) {
  const {
    workplaceId,
    workplaceLabel,
    clockIn,
    clockOut,
    gpsLat,
    gpsLng,
    distanceM,
    offsiteFlag,
    isRetroactive,
    prevHash,
  } = entry;

  const entryHash = computeEntryHash({
    clockIn,
    clockOut,
    gpsLat,
    gpsLng,
    distanceM,
    offsiteFlag,
    isRetroactive,
    prevHash,
  });

  const { rows } = await client.query(
    `INSERT INTO hours_log
       (worker_id, workplace_id, clock_in, clock_out, gps_lat, gps_lng,
        distance_m, offsite_flag, is_retroactive, prev_hash, entry_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id, workplace_id, clock_in, clock_out, gps_lat, gps_lng,
               distance_m, offsite_flag, is_retroactive, prev_hash, entry_hash,
               created_at`,
    [
      workerId,
      workplaceId,
      clockIn,
      clockOut,
      gpsLat,
      gpsLng,
      distanceM,
      offsiteFlag,
      isRetroactive,
      prevHash,
      entryHash,
    ]
  );

  return rowToShift({ ...rows[0], workplace_label: workplaceLabel ?? null });
}

// ---------------------------------------------------------------------------
// GET /api/shifts
// ---------------------------------------------------------------------------
router.get('/', async (req, res, next) => {
  try {
    const raw = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(raw) ? Math.min(200, Math.max(1, raw)) : 50;

    const entries = await loadEntries(pool, req.workerId);
    const collapsed = collapse(entries);

    const openShift = findOpenShift(collapsed);
    const shifts = collapsed.sort(newestFirst).slice(0, limit);

    res.json({ shifts, openShift });
  } catch (err) {
    sendError(err, res, next);
  }
});

// ---------------------------------------------------------------------------
// POST /api/shifts/clock-in
// ---------------------------------------------------------------------------
router.post('/clock-in', async (req, res, next) => {
  try {
    const gps = sanitizeGps(req.body?.gps);

    const shift = await withChainLock(req.workerId, async ({ client, entries, prevHash }) => {
      const open = findOpenShift(collapse(entries));
      if (open) {
        throw new HttpError(409, { error: 'a shift is already open', openShift: open });
      }

      const workplaces = await loadWorkplaces(client, req.workerId);
      const near = nearestWorkplace(gps, workplaces);

      return insertEntry(client, req.workerId, {
        workplaceId: near.workplaceId,
        workplaceLabel: near.label,
        // Server time. The worker's claim and the server's receipt are the same
        // instant for a contemporaneous entry, which is the whole point.
        clockIn: new Date().toISOString(),
        clockOut: null,
        gpsLat: gps ? gps.lat : null,
        gpsLng: gps ? gps.lng : null,
        distanceM: near.distanceM,
        offsiteFlag: near.offsiteFlag,
        isRetroactive: false,
        prevHash,
      });
    });

    res.status(201).json({ shift });
  } catch (err) {
    sendError(err, res, next);
  }
});

// ---------------------------------------------------------------------------
// POST /api/shifts/clock-out
//
// Appends a new entry repeating the open shift's clock_in and adding a
// clock_out. The open row is left exactly as written -- the ledger records that
// the worker clocked in at T1 and, separately, that they closed that shift at
// T2. GET / collapses the pair.
// ---------------------------------------------------------------------------
router.post('/clock-out', async (req, res, next) => {
  try {
    const gps = sanitizeGps(req.body?.gps);

    const shift = await withChainLock(req.workerId, async ({ client, entries, prevHash }) => {
      const open = findOpenShift(collapse(entries));
      if (!open) throw new HttpError(404, { error: 'no open shift' });

      const workplaces = await loadWorkplaces(client, req.workerId);
      const near = nearestWorkplace(gps, workplaces);

      return insertEntry(client, req.workerId, {
        workplaceId: near.workplaceId,
        workplaceLabel: near.label,
        clockIn: open.clockIn,
        clockOut: new Date().toISOString(),
        gpsLat: gps ? gps.lat : null,
        gpsLng: gps ? gps.lng : null,
        distanceM: near.distanceM,
        offsiteFlag: near.offsiteFlag,
        isRetroactive: open.isRetroactive,
        prevHash,
      });
    });

    res.status(201).json({ shift });
  } catch (err) {
    sendError(err, res, next);
  }
});

// ---------------------------------------------------------------------------
// POST /api/shifts/retroactive
//
// Honest by construction: the entry is marked is_retroactive, and created_at
// still records when the claim was actually made. The gap between clock_in and
// created_at is visible rather than hidden.
// ---------------------------------------------------------------------------
router.post('/retroactive', async (req, res, next) => {
  try {
    const body = req.body ?? {};

    if (typeof body.clockIn !== 'string' || typeof body.clockOut !== 'string') {
      throw new HttpError(400, { error: 'clockIn and clockOut are required ISO timestamps' });
    }

    const inMs = Date.parse(body.clockIn);
    const outMs = Date.parse(body.clockOut);

    if (!Number.isFinite(inMs)) throw new HttpError(400, { error: 'clockIn is not a valid timestamp' });
    if (!Number.isFinite(outMs)) throw new HttpError(400, { error: 'clockOut is not a valid timestamp' });
    if (outMs <= inMs) throw new HttpError(400, { error: 'clockOut must be after clockIn' });

    const now = Date.now();
    if (inMs > now || outMs > now) {
      throw new HttpError(400, { error: 'timestamps cannot be in the future' });
    }

    const clockIn = new Date(inMs).toISOString();
    const clockOut = new Date(outMs).toISOString();
    const gps = sanitizeGps(body.gps);

    const shift = await withChainLock(req.workerId, async ({ client, prevHash }) => {
      const workplaces = await loadWorkplaces(client, req.workerId);
      const near = nearestWorkplace(gps, workplaces);

      return insertEntry(client, req.workerId, {
        workplaceId: near.workplaceId,
        workplaceLabel: near.label,
        clockIn,
        clockOut,
        gpsLat: gps ? gps.lat : null,
        gpsLng: gps ? gps.lng : null,
        distanceM: near.distanceM,
        offsiteFlag: near.offsiteFlag,
        isRetroactive: true,
        prevHash,
      });
    });

    res.status(201).json({ shift });
  } catch (err) {
    sendError(err, res, next);
  }
});

// ---------------------------------------------------------------------------
// GET /api/shifts/verify
//
// Walks the raw chain -- every entry, including superseded ones. Collapsing is
// a presentation concern; the chain is what it is.
// ---------------------------------------------------------------------------
router.get('/verify', async (req, res, next) => {
  try {
    const entries = await loadEntries(pool, req.workerId);
    const { valid, brokenAt, reason } = verifyChain(entries);

    res.json({
      valid,
      entryCount: entries.length,
      brokenAt,
      reason,
      latestHash: entries.length ? entries[entries.length - 1].entryHash : null,
    });
  } catch (err) {
    sendError(err, res, next);
  }
});

export default router;
