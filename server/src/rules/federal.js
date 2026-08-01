/**
 * Federal overtime — Fair Labor Standards Act, 29 U.S.C. § 207(a)(1).
 *
 * The floor. Every state must at least match it, and it is deliberately the
 * simplest module in the engine:
 *
 *     hours in a workweek > 40  →  1.5 × regular rate on the excess
 *
 * There is NO DAILY OVERTIME under federal law. A 13-hour day followed by four
 * 3-hour days is 25 hours and owes not one cent of premium — see fixture
 * `federal-long-day-no-overtime`. Reaching for a daily rule here is the classic
 * way to overstate a federal claim, and an overstated claim is worse than no
 * claim: a worker who walks into a labor commissioner's office with an inflated
 * number has a weaker case than one who walks in with a conservative one.
 *
 * There is also no federal meal or rest premium — `findPotentialPremiums`
 * returns an empty array rather than inventing an equivalent.
 *
 * Pure: no DB, no clock, no I/O. Takes one Workweek from rules/workweek.js.
 */

/** The statutory basis cited on every premium hour this module promotes. */
export const STATUTE = '29 U.S.C. § 207(a)(1)';

/** Weekly threshold above which hours are paid at 1.5×. */
export const WEEKLY_OVERTIME_THRESHOLD_HOURS = 40;

/** Tolerance for the bucket-sum invariant: float dust only, never a real hour. */
const EPSILON_HOURS = 1e-9;

/**
 * Splits one workweek's hours into straight time, 1.5× and 2.0× buckets.
 *
 * @param {{totalHours?: number, workdays?: Array<{hours:number}>}} workweek
 * @returns {{straightHours:number, overtimeHours:number, doubleTimeHours:number, reasons:Array<{hours:number,multiplier:number,basis:string,statute:string}>}}
 */
export function computeHours(workweek) {
  const totalHours = totalHoursOf(workweek);

  // Subtract rather than compute both independently: this makes the buckets sum
  // to the total by construction, not by luck of rounding.
  const straightHours = Math.min(totalHours, WEEKLY_OVERTIME_THRESHOLD_HOURS);
  const overtimeHours = totalHours - straightHours;
  const doubleTimeHours = 0; // federal law has no double-time tier at all

  const reasons = [];
  if (overtimeHours > 0) {
    reasons.push({
      hours: overtimeHours,
      multiplier: 1.5,
      basis: `weekly overtime (over ${WEEKLY_OVERTIME_THRESHOLD_HOURS} hours in a workweek)`,
      statute: STATUTE,
    });
  }

  const breakdown = { straightHours, overtimeHours, doubleTimeHours, reasons };
  assertBucketsSum(breakdown, totalHours);
  return breakdown;
}

/**
 * Federal law has no meal or rest break premium equivalent to Cal. Lab. Code
 * § 226.7. Always `[]` — the honest answer, not a fabricated one.
 *
 * The signature matches rules/california.js so the analysis endpoint can select
 * a jurisdiction module without special-casing.
 *
 * @returns {Array} always empty
 */
export function findPotentialPremiums(_workweek, _hourlyRate) {
  return [];
}

/**
 * Wages owed for one breakdown, in CENTS.
 *
 * Money is integer cents internally and rounded exactly once, here, at the
 * boundary — never accumulated as floats across a loop of workweeks.
 *
 * @param {{straightHours:number, overtimeHours:number, doubleTimeHours:number}} breakdown
 * @param {number} hourlyRate regular rate in dollars (for this scope, = hourly rate)
 * @returns {number} integer cents
 */
export function owedCents(breakdown, hourlyRate) {
  const rateCents = Math.round(hourlyRate * 100);
  return Math.round(
    breakdown.straightHours * rateCents +
      breakdown.overtimeHours * rateCents * 1.5 +
      breakdown.doubleTimeHours * rateCents * 2
  );
}

function totalHoursOf(workweek) {
  if (workweek && Number.isFinite(workweek.totalHours)) return workweek.totalHours;
  const days = workweek?.workdays ?? [];
  return days.reduce((sum, d) => sum + (d.hours ?? 0), 0);
}

/**
 * Contract rule 3: every hour lands in exactly one bucket. If this ever fails,
 * some hour has been double-counted or lost, and every downstream figure — the
 * owed total, the discrepancy, the PDF a worker hands to an investigator — is
 * wrong. Fail loudly instead of quietly producing a number.
 */
function assertBucketsSum({ straightHours, overtimeHours, doubleTimeHours }, totalHours) {
  const sum = straightHours + overtimeHours + doubleTimeHours;
  if (Math.abs(sum - totalHours) > EPSILON_HOURS) {
    throw new Error(
      `federal.computeHours: buckets must sum to totalHours — ` +
        `${straightHours} + ${overtimeHours} + ${doubleTimeHours} = ${sum}, expected ${totalHours}`
    );
  }
}
