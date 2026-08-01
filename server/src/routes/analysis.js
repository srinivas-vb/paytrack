import { Router } from 'express';

import { query } from '../db.js';
import { requireWorker } from '../lib/worker.js';
import { bucketShifts } from '../rules/workweek.js';
import { owedCents, toDollars, assertBucketsSum } from '../rules/money.js';
import * as federal from '../rules/federal.js';
import * as california from '../rules/california.js';

const router = Router();
router.use(requireWorker);

const JURISDICTIONS = { federal, california };

// Cal. Lab. Code s 226(a) -- the nine elements a wage statement must show.
// See docs/wage-rules.md s5.
const REQUIRED_WAGE_STATEMENT_FIELDS = [
  { element: 'gross_wages', label: 'Gross wages earned', statute: 'Cal. Lab. Code § 226(a)(1)' },
  { element: 'total_hours', label: 'Total hours worked', statute: 'Cal. Lab. Code § 226(a)(2)' },
  { element: 'piece_rate', label: 'Piece-rate units and rate, if applicable', statute: 'Cal. Lab. Code § 226(a)(3)' },
  { element: 'deductions', label: 'All deductions', statute: 'Cal. Lab. Code § 226(a)(4)' },
  { element: 'net_wages', label: 'Net wages earned', statute: 'Cal. Lab. Code § 226(a)(5)' },
  { element: 'pay_period_dates', label: 'Inclusive dates of the pay period', statute: 'Cal. Lab. Code § 226(a)(6)' },
  { element: 'employee_identity', label: 'Employee name and last four of SSN or employee ID', statute: 'Cal. Lab. Code § 226(a)(7)' },
  { element: 'employer_identity', label: 'Employer name and address', statute: 'Cal. Lab. Code § 226(a)(8)' },
  { element: 'hourly_rates', label: 'All applicable hourly rates and hours worked at each', statute: 'Cal. Lab. Code § 226(a)(9)' },
];

const SCOPE_EXCLUSIONS = ['tips', 'commissions', 'nondiscretionary bonuses'];

const num = (v) => (v === null || v === undefined ? null : Number(v));

/**
 * GET /api/analysis?paystubId=<id>&jurisdiction=<federal|california>
 *
 * Composes the bucketer with a jurisdiction module. The heavy lifting lives in
 * rules/ -- this route's job is to pick the right shifts, run them through,
 * and shape the result. Deliberately thin: the parts that can be wrong in an
 * expensive way are pure functions tested against hand-computed fixtures.
 */
router.get('/', async (req, res, next) => {
  try {
    const jurisdictionKey = String(req.query.jurisdiction || 'federal').toLowerCase();
    const rules = JURISDICTIONS[jurisdictionKey];
    if (!rules) {
      return res.status(400).json({
        error: `unknown jurisdiction '${jurisdictionKey}' -- supported: ${Object.keys(JURISDICTIONS).join(', ')}`,
      });
    }

    const paystubId = Number(req.query.paystubId);
    if (!Number.isSafeInteger(paystubId) || paystubId <= 0) {
      return res.status(400).json({ error: 'paystubId is required' });
    }

    const { rows: stubs } = await query(
      `SELECT id, period_start, period_end, paid_hours, paid_rate, gross_pay, missing_required_fields
         FROM paystubs
        WHERE id = $1 AND worker_id = $2`,
      [paystubId, req.workerId]
    );
    if (stubs.length === 0) return res.status(404).json({ error: 'not found' });

    const stub = stubs[0];
    const hourlyRate = num(stub.paid_rate);
    if (!hourlyRate || hourlyRate <= 0) {
      return res.status(400).json({
        error: 'this paystub has no usable hourly rate, so nothing can be computed from it',
      });
    }

    // Shifts overlapping the pay period. Bounds are inclusive of the period's
    // last day, so clock_in is compared against the day AFTER period_end.
    const { rows: shiftRows } = await query(
      `SELECT id, clock_in, clock_out
         FROM hours_log
        WHERE worker_id = $1
          AND clock_out IS NOT NULL
          AND clock_in >= $2::date
          AND clock_in <  ($3::date + interval '1 day')
        ORDER BY id ASC`,
      [req.workerId, stub.period_start, stub.period_end]
    );

    // hours_log is append-only, so a clock-out writes a NEW row carrying the
    // same clock_in. Collapse those pairs or every completed shift is counted
    // twice -- which would roughly double the amount claimed.
    const byClockIn = new Map();
    for (const r of shiftRows) {
      const key = new Date(r.clock_in).toISOString();
      const existing = byClockIn.get(key);
      if (!existing || Number(r.id) > Number(existing.id)) byClockIn.set(key, r);
    }

    const shifts = [...byClockIn.values()].map((r) => ({
      id: Number(r.id),
      clockIn: new Date(r.clock_in).toISOString(),
      clockOut: new Date(r.clock_out).toISOString(),
    }));

    const workweeks = bucketShifts(shifts, { workweekStartsOn: 0, timezone: 'UTC' });

    let totalOwedCents = 0;
    const potentialPremiums = [];

    const weekResults = workweeks.map((week) => {
      const breakdown = rules.computeHours(week);
      assertBucketsSum(breakdown, week.totalHours, `${jurisdictionKey} ${week.start}`);

      const cents = owedCents(breakdown, hourlyRate);
      totalOwedCents += cents;

      potentialPremiums.push(...rules.findPotentialPremiums(week, hourlyRate));

      return {
        start: week.start,
        end: week.end,
        totalHours: week.totalHours,
        breakdown,
        owed: toDollars(cents),
      };
    });

    const totalPaidCents = Math.round(num(stub.gross_pay ?? 0) * 100);

    // The COLUMN stores the missing elements; the API accepts `presentFields`
    // and inverts on write (routes/paystubs.js). Getting this backwards would
    // flag precisely the elements that ARE present -- a silent inversion that
    // reads as a plausible result, so the column name is the source of truth
    // and the inversion happens exactly once, on write.
    const missing = new Set(stub.missing_required_fields || []);
    const complianceFlags = REQUIRED_WAGE_STATEMENT_FIELDS.filter((f) =>
      missing.has(f.element)
    );

    res.json({
      jurisdiction: jurisdictionKey,
      hourlyRate,
      paystubId: Number(stub.id),
      periodStart: stub.period_start,
      periodEnd: stub.period_end,
      shiftCount: shifts.length,
      workweeks: weekResults,
      totalOwed: toDollars(totalOwedCents),
      totalPaid: toDollars(totalPaidCents),
      // Zero or negative is a correct, ordinary result -- not an error and not
      // an empty state. An engine that only ever finds violations is an
      // accusation generator, not evidence.
      discrepancy: toDollars(totalOwedCents - totalPaidCents),
      // Deliberately separate from `discrepancy`. PayTrack sees clock-in and
      // clock-out, never breaks -- see docs/wage-rules.md s4.
      potentialPremiums,
      complianceFlags,
      scopeExclusions: SCOPE_EXCLUSIONS,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
