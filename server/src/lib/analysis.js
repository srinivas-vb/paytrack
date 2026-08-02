import { query } from '../db.js';
import { bucketShifts } from '../rules/workweek.js';
import { owedCents, toDollars, assertBucketsSum } from '../rules/money.js';
import * as federal from '../rules/federal.js';
import * as california from '../rules/california.js';
import { REQUIRED_ELEMENTS } from '../routes/paystubs.js';

/**
 * The analysis computation, lifted out of the route so /api/explain can run
 * the SAME numbers rather than deriving its own.
 *
 * That is the point: an explainer that recomputes, or worse infers figures
 * from prose, can disagree with the screen. A worker reading two different
 * amounts for the same pay period has a record they cannot use.
 *
 * Returns { httpStatus, analysis } or { httpStatus, error } -- the caller
 * decides how to render it.
 */
const JURISDICTIONS = { federal, california };
const SCOPE_EXCLUSIONS = ['tips', 'commissions', 'nondiscretionary bonuses'];
const num = (v) => (v === null || v === undefined ? null : Number(v));

export { JURISDICTIONS, SCOPE_EXCLUSIONS };

export async function computeAnalysis({ workerId, paystubIdRaw, jurisdiction }) {

    const jurisdictionKey = String(jurisdiction || 'federal').toLowerCase();
    const rules = JURISDICTIONS[jurisdictionKey];
    if (!rules) {
      return {
        httpStatus: 400,
        error: {
          error: `unknown jurisdiction '${jurisdictionKey}' -- supported: ${Object.keys(JURISDICTIONS).join(', ')}`,
        },
      };
    }

    const paystubId = Number(paystubIdRaw);
    if (!Number.isSafeInteger(paystubId) || paystubId <= 0) {
      return { httpStatus: 400, error: { error: 'paystubId is required' } };
    }

    const { rows: stubs } = await query(
      `SELECT id, period_start, period_end, paid_hours, paid_rate, gross_pay, missing_required_fields
         FROM paystubs
        WHERE id = $1 AND worker_id = $2`,
      [paystubId, workerId]
    );
    if (stubs.length === 0) return { httpStatus: 404, error: { error: 'not found' } };

    const stub = stubs[0];
    const hourlyRate = num(stub.paid_rate);
    if (!hourlyRate || hourlyRate <= 0) {
      return {
        httpStatus: 400,
        error: {
          error: 'this paystub has no usable hourly rate, so nothing can be computed from it',
        },
      };
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
      [workerId, stub.period_start, stub.period_end]
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
    //
    // NULL is tri-state and means "not assessed", NOT "all nine missing". A
    // worker who never opened the checklist has not thereby reported nine
    // violations. `|| []` collapses NULL to an empty set, so no flags.
    const missing = new Set(stub.missing_required_fields || []);
    const complianceFlags = REQUIRED_ELEMENTS.filter((f) => missing.has(f.key)).map(
      (f) => ({ element: f.key, label: f.label, statute: f.statute })
    );

    return { httpStatus: 200, analysis: {
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
    } };
}
