/**
 * Money for the rule engine. One source of truth for turning an HourBreakdown
 * into dollars, shared by every jurisdiction.
 *
 * The multipliers are universal even though the RULES for which hours land in
 * which bucket are not: straight time is 1.0x, overtime 1.5x, double time 2.0x
 * everywhere. Only the bucketing differs by jurisdiction, and that lives in
 * federal.js / california.js.
 *
 * Everything is computed in integer CENTS and rounded exactly once, at the
 * point a value becomes a number a human reads. Accumulating dollars as floats
 * across a loop of workweeks drifts, and a discrepancy figure that is off by a
 * cent is a figure someone can attack.
 */

export const MULTIPLIER = {
  straight: 1.0,
  overtime: 1.5,
  doubleTime: 2.0,
};

/**
 * @param {{straightHours:number, overtimeHours:number, doubleTimeHours:number}} breakdown
 * @param {number} hourlyRate dollars per hour
 * @returns {number} integer cents
 */
export function owedCents(breakdown, hourlyRate) {
  const rateCents = Math.round(hourlyRate * 100);

  // Round each bucket independently, then sum integers. Summing floats first
  // and rounding once at the end lets sub-cent dust from three multiplications
  // accumulate across every workweek in the period.
  return (
    Math.round(breakdown.straightHours * rateCents * MULTIPLIER.straight) +
    Math.round(breakdown.overtimeHours * rateCents * MULTIPLIER.overtime) +
    Math.round(breakdown.doubleTimeHours * rateCents * MULTIPLIER.doubleTime)
  );
}

/** Integer cents -> a number safe to render as dollars. */
export function toDollars(cents) {
  return Math.round(cents) / 100;
}

/**
 * Guards the invariant every jurisdiction module must satisfy: every hour lands
 * in exactly one bucket. A violation means hours were double-counted (overtime
 * pyramided) or silently dropped -- both produce a confidently wrong dollar
 * figure rather than an obvious failure, which is the worst kind of bug here.
 */
export function assertBucketsSum(breakdown, totalHours, context = '') {
  const sum =
    breakdown.straightHours + breakdown.overtimeHours + breakdown.doubleTimeHours;

  if (Math.abs(sum - totalHours) > 1e-9) {
    throw new Error(
      `hour buckets do not sum to total${context ? ` (${context})` : ''}: ` +
        `${breakdown.straightHours} + ${breakdown.overtimeHours} + ${breakdown.doubleTimeHours} ` +
        `= ${sum}, expected ${totalHours}`
    );
  }
}
