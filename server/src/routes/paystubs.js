/**
 * /api/paystubs -- what the employer SAYS it paid.
 *
 * This is the other half of the evidence. `hours_log` is what the worker
 * recorded; a paystub is the employer's own assertion about the same period.
 * The discrepancy between them is the whole product, so this table is
 * deliberately dumb: it stores the claim verbatim and computes nothing. The
 * rule engine reads it later and is the only place arithmetic happens.
 *
 * Unlike hours_log, paystubs is NOT append-only. A paystub is a transcription
 * of a document the worker already holds -- a typo in it is a data-entry
 * mistake, not a revision of history, and DELETE is the honest fix. The
 * append-only guarantee protects the contemporaneous record of hours, and
 * stretching it over transcriptions would dilute the claim rather than
 * strengthen it.
 */
import { Router } from 'express';

import { query } from '../db.js';
import { requireWorker } from '../lib/worker.js';

const router = Router();

// Worker-scoped, like every other router. Applied here so identity is enforced
// regardless of where index.js mounts this.
router.use(requireWorker);

// ---------------------------------------------------------------------------
// Cal. Lab. Code s 226(a) -- the nine required elements.
//
// Listed in docs/wage-rules.md s5; the keys below are the wire representation
// of that list and the vocabulary of `presentFields`. Exported so the analysis
// endpoint emits compliance flags naming exactly these elements rather than a
// second, subtly different set.
//
// Note what a flag here does and does not mean. The worker ticks what they can
// see on the statement in front of them. An unticked box means "not recorded
// here" -- it is NOT proof the original statement omitted it, and both this
// module and the UI say so in those words.
// ---------------------------------------------------------------------------
export const REQUIRED_ELEMENTS = [
  { key: 'gross_wages', statute: 'Cal. Lab. Code § 226(a)(1)', label: 'Gross wages earned' },
  { key: 'total_hours', statute: 'Cal. Lab. Code § 226(a)(2)', label: 'Total hours worked' },
  { key: 'piece_rate_units', statute: 'Cal. Lab. Code § 226(a)(3)', label: 'Piece-rate units and rate, if any' },
  { key: 'deductions', statute: 'Cal. Lab. Code § 226(a)(4)', label: 'All deductions' },
  { key: 'net_wages', statute: 'Cal. Lab. Code § 226(a)(5)', label: 'Net wages earned' },
  { key: 'pay_period_dates', statute: 'Cal. Lab. Code § 226(a)(6)', label: 'Inclusive dates of the pay period' },
  { key: 'employee_name_and_id', statute: 'Cal. Lab. Code § 226(a)(7)', label: 'Employee name and last 4 of SSN or employee ID' },
  { key: 'employer_name_and_address', statute: 'Cal. Lab. Code § 226(a)(8)', label: 'Employer name and address' },
  { key: 'hourly_rates', statute: 'Cal. Lab. Code § 226(a)(9)', label: 'All hourly rates and hours worked at each' },
];

const ELEMENT_KEYS = REQUIRED_ELEMENTS.map((e) => e.key);
const ELEMENT_KEY_SET = new Set(ELEMENT_KEYS);

const PAID_HOURS_MAX = 1000;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Parses a strict YYYY-MM-DD calendar date to a UTC epoch-ms midnight, or null.
 *
 * Round-tripping through Date.UTC and comparing the components back out is what
 * rejects 2026-02-30: Date.UTC happily rolls it forward to March 2, and only
 * the comparison notices. A regex alone would accept it.
 *
 * Deliberately NOT Date.parse(): that accepts "2026-7-5", "July 5 2026" and a
 * pile of other shapes the contract does not describe, and a paystub period is
 * a calendar date with no time zone -- treating it as an instant would make the
 * boundary behave differently for a worker in Los Angeles than in Berlin.
 */
function parseCalendarDate(raw) {
  const m = DATE_RE.exec(raw);
  if (!m) return null;

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);

  const ms = Date.UTC(year, month - 1, day);
  const d = new Date(ms);
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return null;
  }
  return ms;
}

/** Today at UTC midnight. See validateBody for why UTC and not server-local. */
function todayUtcMs() {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

/**
 * A required, real, finite JSON number.
 *
 * Number.isFinite() is doing specific work here. `typeof NaN === 'number'` is
 * true, so a bare type check admits NaN -- and NaN silently poisons every
 * downstream comparison instead of failing loudly (NaN <= 1000 is false, so a
 * range check "happens" to reject it, but only by accident, and Infinity would
 * sail straight through a range check written the other way round). Stating
 * finiteness directly means the rejection is intentional rather than lucky.
 */
function requireFiniteNumber(name, value) {
  if (value === undefined || value === null) {
    return { error: `${name} is required` };
  }
  // Strings are rejected rather than coerced: the contract says JSON number,
  // and Number("") === 0 would turn an empty form field into a real zero.
  if (typeof value !== 'number') {
    return { error: `${name} must be a number` };
  }
  if (!Number.isFinite(value)) {
    return { error: `${name} must be a finite number` };
  }
  return { value };
}

/**
 * Normalises `presentFields`.
 *
 * Three distinct states, and the difference matters legally:
 *   undefined/null -> null       "nobody assessed the statement"
 *   []             -> all nine missing
 *   [...]          -> the listed nine minus those
 *
 * Storing null rather than "all nine missing" for an unanswered form keeps the
 * analysis from reporting nine violations against a worker who simply skipped
 * the checkboxes. Absence of an answer is not an answer.
 */
function normalisePresentFields(raw) {
  if (raw === undefined || raw === null) return { value: null };

  if (!Array.isArray(raw)) {
    return { error: 'presentFields must be an array of strings' };
  }

  const present = new Set();
  for (const item of raw) {
    if (typeof item !== 'string') {
      return { error: 'presentFields must be an array of strings' };
    }
    const key = item.trim();
    // Unknown keys are rejected rather than dropped. Silently ignoring a
    // misspelled element would report it as MISSING -- an unearned violation
    // manufactured by a client typo, which is exactly the failure mode this
    // whole app exists to avoid.
    if (!ELEMENT_KEY_SET.has(key)) {
      return {
        error: `presentFields contains an unknown element "${item}". Valid values: ${ELEMENT_KEYS.join(', ')}`,
      };
    }
    present.add(key);
  }

  // Stored in the canonical statute order, not the client's order, so two
  // equivalent submissions produce identical rows.
  return { value: ELEMENT_KEYS.filter((k) => present.has(k)) };
}

/**
 * Validates a POST body against docs/contracts.md.
 *
 * Returns `{ error }` naming the offending field, or `{ value }` with cleaned
 * input. Never throws.
 */
function validateBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'body must be a JSON object' };
  }

  const { periodStart, periodEnd, paidHours, paidRate, grossPay, presentFields } = body;

  for (const [name, value] of [
    ['periodStart', periodStart],
    ['periodEnd', periodEnd],
  ]) {
    if (value === undefined || value === null) return { error: `${name} is required` };
    if (typeof value !== 'string') return { error: `${name} must be a YYYY-MM-DD date string` };
  }

  const startMs = parseCalendarDate(periodStart);
  if (startMs === null) return { error: 'periodStart must be a real date in YYYY-MM-DD form' };

  const endMs = parseCalendarDate(periodEnd);
  if (endMs === null) return { error: 'periodEnd must be a real date in YYYY-MM-DD form' };

  if (endMs <= startMs) return { error: 'periodEnd must be after periodStart' };

  // Compared against UTC today, not server-local today. The server's time zone
  // is an accident of where Render happens to run the process; a worker on the
  // US west coast entering "today's" pay period at 5pm local is already on
  // tomorrow's UTC date. UTC is the most permissive defensible line -- it never
  // rejects a date the worker considers already past.
  const today = todayUtcMs();
  if (startMs > today) return { error: 'periodStart cannot be in the future' };
  if (endMs > today) return { error: 'periodEnd cannot be in the future' };

  const hours = requireFiniteNumber('paidHours', paidHours);
  if (hours.error) return { error: hours.error };
  if (hours.value < 0 || hours.value > PAID_HOURS_MAX) {
    return { error: `paidHours must be between 0 and ${PAID_HOURS_MAX}` };
  }

  const rate = requireFiniteNumber('paidRate', paidRate);
  if (rate.error) return { error: rate.error };
  if (rate.value <= 0) return { error: 'paidRate must be greater than 0' };

  const gross = requireFiniteNumber('grossPay', grossPay);
  if (gross.error) return { error: gross.error };
  if (gross.value < 0) return { error: 'grossPay must be 0 or more' };

  const fields = normalisePresentFields(presentFields);
  if (fields.error) return { error: fields.error };

  return {
    value: {
      periodStart,
      periodEnd,
      paidHours: hours.value,
      paidRate: rate.value,
      grossPay: gross.value,
      presentFields: fields.value,
      missingRequiredFields:
        fields.value === null ? null : ELEMENT_KEYS.filter((k) => !fields.value.includes(k)),
    },
  };
}

/**
 * Parses `:id`. Anything that is not a positive integer cannot be a row we own,
 * so it answers 404 -- identically to a real id belonging to somebody else.
 * A 403 would confirm to a stranger that the row exists.
 */
function parseId(raw) {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

/**
 * Maps a paystubs row to the API shape.
 *
 * Two node-pg boundary quirks are handled here rather than leaked:
 *
 *   - BIGSERIAL ids come back as strings (precision guard past 2^53). The
 *     contract says number and hackathon ids are nowhere near that ceiling.
 *   - NUMERIC comes back as a string for the same reason. Money is stored to
 *     two decimals and read once, so Number() is safe here -- but note that
 *     the rule engine must still accumulate in cents, per contracts.md.
 *
 * DATE is not converted here at all: the SELECT uses to_char, because node-pg
 * parses a bare DATE into a Date at LOCAL midnight, and toISOString() on that
 * can shift the calendar day backwards in any zone west of UTC. A pay period
 * that silently starts a day early is a wrong answer nobody would think to
 * look for.
 */
function toPaystub(row) {
  const present = row.missing_required_fields === null
    ? null
    : ELEMENT_KEYS.filter((k) => !row.missing_required_fields.includes(k));

  return {
    id: Number(row.id),
    periodStart: row.period_start,
    periodEnd: row.period_end,
    paidHours: row.paid_hours === null ? null : Number(row.paid_hours),
    paidRate: row.paid_rate === null ? null : Number(row.paid_rate),
    grossPay: row.gross_pay === null ? null : Number(row.gross_pay),
    presentFields: present,
    missingRequiredFields: row.missing_required_fields ?? null,
    extractionSource: row.extraction_source,
    createdAt: row.created_at.toISOString(),
  };
}

const PAYSTUB_SELECT = `
  SELECT id,
         to_char(period_start, 'YYYY-MM-DD') AS period_start,
         to_char(period_end,   'YYYY-MM-DD') AS period_end,
         paid_hours,
         paid_rate,
         gross_pay,
         missing_required_fields,
         extraction_source,
         created_at
    FROM paystubs
`;

// ---------------------------------------------------------------------------
// GET /api/paystubs
//
// Newest first. "Newest" means the most recent PAY PERIOD, not the most recent
// keystroke: a worker entering a backlog of stubs out of order should still see
// them in the order they were paid. created_at breaks ties so the ordering is
// total and the list never reshuffles between renders.
// ---------------------------------------------------------------------------
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(
      `${PAYSTUB_SELECT}
        WHERE worker_id = $1
        ORDER BY period_start DESC NULLS LAST, created_at DESC, id DESC`,
      [req.workerId]
    );

    res.json({ paystubs: rows.map(toPaystub) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/paystubs
// ---------------------------------------------------------------------------
router.post('/', async (req, res, next) => {
  const { error, value } = validateBody(req.body);
  if (error) return res.status(400).json({ error });

  try {
    // created_at is left to the column default -- server time only. A client
    // must never be able to backdate anything in this system, including its
    // own transcription of a document.
    const { rows } = await query(
      `INSERT INTO paystubs
         (worker_id, period_start, period_end, paid_hours, paid_rate, gross_pay,
          missing_required_fields, extraction_source)
       VALUES ($1, $2::date, $3::date, $4, $5, $6, $7, 'manual')
       RETURNING id,
                 to_char(period_start, 'YYYY-MM-DD') AS period_start,
                 to_char(period_end,   'YYYY-MM-DD') AS period_end,
                 paid_hours, paid_rate, gross_pay,
                 missing_required_fields, extraction_source, created_at`,
      [
        req.workerId,
        value.periodStart,
        value.periodEnd,
        value.paidHours,
        value.paidRate,
        value.grossPay,
        value.missingRequiredFields,
      ]
    );

    return res.status(201).json({ paystub: toPaystub(rows[0]) });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/paystubs/:id
//
// A hard delete, and that is the right call here -- see the module header.
// Scoped by worker_id as well as id: another worker's row must 404, never 403.
// ---------------------------------------------------------------------------
router.delete('/:id', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(404).json({ error: 'not found' });

  try {
    const { rowCount } = await query(
      'DELETE FROM paystubs WHERE id = $1 AND worker_id = $2',
      [id, req.workerId]
    );

    if (rowCount === 0) return res.status(404).json({ error: 'not found' });

    return res.status(204).end();
  } catch (err) {
    return next(err);
  }
});

export default router;
