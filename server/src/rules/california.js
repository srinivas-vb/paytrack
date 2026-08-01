/**
 * California wage rules — Labor Code § 510 (overtime) and § 226.7 (meal/rest).
 *
 * PURE MODULE. No DB, no clock, no I/O, no imports. Given a `Workweek` it
 * returns the same answer forever, which is the only reason it can be checked
 * against hand-computed fixtures (`server/src/rules/fixtures.js`).
 *
 * THE RULE THIS FILE EXISTS TO GET RIGHT — California does not pyramid
 * overtime. An hour is promoted to a premium rate ONCE. Compute in this order:
 *
 *   1. Per workday: first 8 hours straight, hours 8–12 at 1.5x, beyond 12 at 2.0x.
 *   2. Per workweek: sum ONLY the straight-time hours surviving step 1. Any
 *      amount over 40 converts from 1.0x to 1.5x.
 *   3. Hours already promoted in step 1 are NEVER re-counted in step 2.
 *
 * Five 9-hour days is the canonical trap. 45 hours; step 1 yields 40 straight
 * + 5 at 1.5x; step 2 sees 40 straight-time hours, which is not over 40, so it
 * adds nothing. Owed is $950 at $20/hr. The naive implementation counts the 5
 * daily-OT hours AND another 5 weekly-OT hours (45 − 40) and reports $1,100 —
 * a 16% overstatement on the headline number a worker would take to the labor
 * commissioner. See fixture `ca-nine-hour-days`.
 *
 * ARITHMETIC STANCE
 *   - Hours are accumulated as INTEGER SECONDS, never as floats. That is what
 *     makes `straight + overtime + doubleTime === total` exactly true rather
 *     than true-to-within-a-rounding-error.
 *   - Money is computed in INTEGER CENTS and rounded once per rate bucket at
 *     the boundary. Nothing is ever accumulated as a float dollar amount.
 */

const SECONDS_PER_HOUR = 3600;

/** § 510(a): first 8 hours of a workday are straight time. */
const DAILY_STRAIGHT_LIMIT_H = 8;
/** § 510(a): beyond 12 hours in a workday is double time. */
const DAILY_DOUBLE_TIME_LIMIT_H = 12;
/** § 510(a): over 40 straight-time hours in a workweek is 1.5x. */
const WEEKLY_STRAIGHT_LIMIT_H = 40;
/** § 510(a)(3): on the 7th consecutive day, the first 8 hours are 1.5x, the rest 2.0x. */
const SEVENTH_DAY_STRAIGHT_LIMIT_H = 8;

const STATUTE_OVERTIME = 'Cal. Lab. Code § 510';
const STATUTE_PREMIUM = 'Cal. Lab. Code § 226.7';

/** § 226.7 / IWC Wage Orders: a meal period is owed for work over 5 hours. */
const MEAL_THRESHOLD_H = 5;
/** A second meal period is owed for work over 10 hours. */
const SECOND_MEAL_THRESHOLD_H = 10;
/** Brinker: no rest period is owed for a shift under 3.5 hours. */
const REST_MINIMUM_H = 3.5;

const hoursToSeconds = (hours) => Math.round(hours * SECONDS_PER_HOUR);
const secondsToHours = (seconds) => seconds / SECONDS_PER_HOUR;

const DAILY_STRAIGHT_LIMIT_S = hoursToSeconds(DAILY_STRAIGHT_LIMIT_H);
const DAILY_DOUBLE_TIME_LIMIT_S = hoursToSeconds(DAILY_DOUBLE_TIME_LIMIT_H);
const WEEKLY_STRAIGHT_LIMIT_S = hoursToSeconds(WEEKLY_STRAIGHT_LIMIT_H);
const SEVENTH_DAY_STRAIGHT_LIMIT_S = hoursToSeconds(SEVENTH_DAY_STRAIGHT_LIMIT_H);

/**
 * Normalises and validates the workdays of a workweek.
 *
 * Sorted by local calendar date, because "the 7th consecutive day" is only
 * meaningful in chronological order and we must not depend on the bucketer
 * happening to emit them sorted.
 */
function normalizeWorkdays(workweek) {
  if (!workweek || typeof workweek !== 'object') {
    throw new TypeError('california: workweek must be an object');
  }
  if (!Array.isArray(workweek.workdays)) {
    throw new TypeError('california: workweek.workdays must be an array');
  }

  const days = workweek.workdays.map((day, i) => {
    if (!day || typeof day !== 'object') {
      throw new TypeError(`california: workday[${i}] must be an object`);
    }
    if (!Number.isFinite(day.hours)) {
      throw new TypeError(`california: workday[${i}].hours must be a finite number`);
    }
    if (day.hours < 0) {
      throw new RangeError(`california: workday[${i}].hours must not be negative`);
    }
    return { date: day.date ?? null, seconds: hoursToSeconds(day.hours), index: i };
  });

  // Stable sort by date; days with no date keep their original relative order
  // and sort last, so a malformed bucketer degrades predictably.
  return days.sort((a, b) => {
    if (a.date === b.date) return a.index - b.index;
    if (a.date === null) return 1;
    if (b.date === null) return -1;
    return a.date < b.date ? -1 : 1;
  });
}

/**
 * Does the 7th-consecutive-day rule apply to this workweek?
 *
 * It applies only when the worker worked ALL SEVEN days of the workweek.
 * Inside a single workweek "seven days worked" and "seven consecutive days
 * worked" are the same condition, so either signal is accepted — we do not
 * require the bucketer to have populated `consecutiveDaysWorked`.
 */
function seventhDayApplies(workweek, daysActuallyWorked) {
  if (daysActuallyWorked >= 7) return true;
  const consecutive = workweek.consecutiveDaysWorked;
  return Number.isFinite(consecutive) && consecutive >= 7;
}

/**
 * Computes the hour breakdown for one California workweek.
 *
 * @param {{workdays: Array<{date?: string|null, hours: number}>, totalHours?: number, consecutiveDaysWorked?: number}} workweek
 * @returns {{straightHours: number, overtimeHours: number, doubleTimeHours: number, reasons: Array<{hours: number, multiplier: number, basis: string, statute: string}>}}
 */
export function computeHours(workweek) {
  const days = normalizeWorkdays(workweek);
  const worked = days.filter((d) => d.seconds > 0);
  const totalSeconds = days.reduce((sum, d) => sum + d.seconds, 0);

  const useSeventhDayRule = seventhDayApplies(workweek, worked.length);
  // The 7th day is the last day actually worked, chronologically.
  const seventhDay = useSeventhDayRule ? worked[worked.length - 1] : null;

  // Accumulators, all in integer seconds and all tracked separately so that
  // `reasons` can cite the specific statutory basis for every promoted hour.
  let straightSec = 0; // step-2 candidates only
  let dailyOtSec = 0; // over 8 in a workday
  let dailyDtSec = 0; // over 12 in a workday
  let seventhOtSec = 0; // 7th consecutive day, first 8 hours
  let seventhDtSec = 0; // 7th consecutive day, beyond 8 hours

  for (const day of days) {
    if (day.seconds === 0) continue;

    if (day === seventhDay) {
      // Step 1, special case: 7th-day hours are promoted DIRECTLY. None of
      // them are straight time, so none of them reach step 2. This is the
      // second place a naive implementation double-counts.
      seventhOtSec += Math.min(day.seconds, SEVENTH_DAY_STRAIGHT_LIMIT_S);
      seventhDtSec += Math.max(day.seconds - SEVENTH_DAY_STRAIGHT_LIMIT_S, 0);
      continue;
    }

    // Step 1, ordinary day.
    straightSec += Math.min(day.seconds, DAILY_STRAIGHT_LIMIT_S);
    dailyOtSec += Math.max(
      Math.min(day.seconds, DAILY_DOUBLE_TIME_LIMIT_S) - DAILY_STRAIGHT_LIMIT_S,
      0
    );
    dailyDtSec += Math.max(day.seconds - DAILY_DOUBLE_TIME_LIMIT_S, 0);
  }

  // Step 2. Only the straight-time hours that SURVIVED step 1 are eligible.
  // Everything already sitting in dailyOtSec / dailyDtSec / seventh*Sec is
  // invisible here, which is precisely the non-pyramiding rule.
  const weeklyOtSec = Math.max(straightSec - WEEKLY_STRAIGHT_LIMIT_S, 0);
  straightSec -= weeklyOtSec;

  const overtimeSec = dailyOtSec + weeklyOtSec + seventhOtSec;
  const doubleTimeSec = dailyDtSec + seventhDtSec;

  // Constraint: every hour lands in exactly one bucket. Enforced in integer
  // seconds so this is an exact equality, not a tolerance.
  if (straightSec + overtimeSec + doubleTimeSec !== totalSeconds) {
    throw new Error(
      `california: bucket invariant violated — ${straightSec}+${overtimeSec}+${doubleTimeSec} !== ${totalSeconds} seconds`
    );
  }

  // Cross-check against the bucketer's own total. Tolerance is one second per
  // workday, the most our per-day rounding to whole seconds can introduce.
  if (Number.isFinite(workweek.totalHours)) {
    const tolerance = (days.length + 1) / SECONDS_PER_HOUR;
    if (Math.abs(secondsToHours(totalSeconds) - workweek.totalHours) > tolerance) {
      throw new Error(
        `california: workweek.totalHours (${workweek.totalHours}) disagrees with the sum of its workdays (${secondsToHours(totalSeconds)})`
      );
    }
  }

  const reasons = [];
  const addReason = (seconds, multiplier, basis) => {
    if (seconds > 0) {
      reasons.push({ hours: secondsToHours(seconds), multiplier, basis, statute: STATUTE_OVERTIME });
    }
  };

  addReason(dailyOtSec, 1.5, 'daily overtime (over 8 in a workday)');
  addReason(dailyDtSec, 2.0, 'daily double time (over 12 in a workday)');
  addReason(weeklyOtSec, 1.5, 'weekly overtime (over 40 straight-time hours in a workweek)');
  addReason(seventhOtSec, 1.5, '7th consecutive day worked — first 8 hours');
  addReason(seventhDtSec, 2.0, '7th consecutive day worked — beyond 8 hours');

  return {
    straightHours: secondsToHours(straightSec),
    overtimeHours: secondsToHours(overtimeSec),
    doubleTimeHours: secondsToHours(doubleTimeSec),
    reasons,
  };
}

/**
 * Wages owed for one workweek, in INTEGER CENTS.
 *
 * Exported because the alternative is every caller re-deriving money from
 * floats. Each rate bucket is rounded exactly once; nothing accumulates.
 *
 * @param {{straightHours: number, overtimeHours: number, doubleTimeHours: number}} breakdown
 * @param {number} hourlyRate dollars per hour
 * @returns {number} integer cents
 */
export function computeOwedCents(breakdown, hourlyRate) {
  if (!Number.isFinite(hourlyRate) || hourlyRate < 0) {
    throw new RangeError('california: hourlyRate must be a non-negative finite number');
  }
  const rateCents = Math.round(hourlyRate * 100);
  return (
    Math.round(breakdown.straightHours * rateCents) +
    Math.round(breakdown.overtimeHours * rateCents * 1.5) +
    Math.round(breakdown.doubleTimeHours * rateCents * 2)
  );
}

/**
 * Rest periods owed for a workday: one per 4 hours worked "or major fraction
 * thereof" (Brinker Restaurant Corp. v. Superior Court, 53 Cal.4th 1004).
 * A "major fraction" is more than half of a 4-hour block, i.e. over 2 hours.
 * No rest period is owed for a shift under 3.5 hours.
 */
function restPeriodsOwed(hours) {
  if (hours < REST_MINIMUM_H) return 0;
  return Math.floor(hours / 4) + (hours % 4 > 2 ? 1 : 0);
}

/**
 * Potential meal/rest premiums for one workweek — § 226.7.
 *
 * READ THIS BEFORE CHANGING ANYTHING HERE.
 *
 * PayTrack sees clock-in and clock-out. IT DOES NOT KNOW WHETHER A BREAK WAS
 * TAKEN. A single unbroken 6-hour entry is equally consistent with a missed
 * meal period and with a worker who took one and did not log it. So these are
 * POTENTIAL premiums: flagged, explained, and NEVER added to `owed`. Every
 * returned object carries an `explanation` saying so in plain language.
 * Overclaiming here is the fastest way to destroy the credibility of the whole
 * record — a worker who walks in with an inflated number has a worse case than
 * one who walks in with a conservative one.
 *
 * MEALS ARE FLAGGED; REST PERIODS ARE NOT, BY DEFAULT. That asymmetry is
 * deliberate and evidentiary, not an oversight:
 *   - A meal period is UNPAID and 30 minutes long, so a properly recorded one
 *     appears in time records as a gap. Time records are therefore genuine
 *     evidence about meal periods (see Donohue v. AMN Services, 11 Cal.5th 58,
 *     where records showing missed or short meal periods raise a rebuttable
 *     presumption of violation).
 *   - A rest period is PAID and 10 minutes long. It never appears in clock
 *     records whether it was taken or not. Clock data carries exactly zero
 *     information about rest periods, so inferring a rest violation from it
 *     would be fabrication rather than evidence.
 * The rest calculation is implemented and available behind
 * `options.includeRestPremiums` for callers who have a separate evidentiary
 * basis (e.g. a worker attestation) — it is off by default.
 *
 * Capped at one meal premium and one rest premium per workday, per § 226.7,
 * even when a second meal period was also owed.
 *
 * @param {{workdays: Array<{date?: string|null, hours: number, shiftIds?: number[]}>}} workweek
 * @param {number} hourlyRate dollars per hour — the regular rate (see wage-rules.md §6)
 * @param {{includeRestPremiums?: boolean}} [options]
 * @returns {Array<{type: string, statute: string, workday: string|null, amount: number, explanation: string}>}
 */
export function findPotentialPremiums(workweek, hourlyRate, options = {}) {
  if (!workweek || typeof workweek !== 'object' || !Array.isArray(workweek.workdays)) {
    throw new TypeError('california: workweek.workdays must be an array');
  }
  if (!Number.isFinite(hourlyRate) || hourlyRate < 0) {
    throw new RangeError('california: hourlyRate must be a non-negative finite number');
  }

  const includeRest = options.includeRestPremiums === true;
  // One additional hour of pay at the regular rate, per § 226.7. Computed in
  // cents and converted once.
  const amount = Math.round(hourlyRate * 100) / 100;

  const premiums = [];

  for (const day of workweek.workdays) {
    if (!day || !Number.isFinite(day.hours) || day.hours <= 0) continue;

    const workday = day.date ?? null;
    const entries = Array.isArray(day.shiftIds) ? day.shiftIds.length : 1;
    const hoursText = formatHours(day.hours);

    // A day recorded as several entries has a gap in it, which may well be a
    // meal break the worker did log. We cannot measure its length or timing
    // from the Workday shape, so we still flag it — but we say so, loudly.
    const recordCaveat =
      entries > 1
        ? ` This workday was recorded as ${entries} separate entries, so a break may have been taken and recorded; PayTrack cannot see its length or timing.`
        : ' This workday was recorded as one unbroken entry.';

    const cannotKnow =
      ' PayTrack sees clock-in and clock-out only — it cannot see whether a break was taken, so this is a potential premium, not an established violation, and it is excluded from the amount owed.';

    if (day.hours > MEAL_THRESHOLD_H) {
      const second =
        day.hours > SECOND_MEAL_THRESHOLD_H
          ? ' Over 10 hours were worked, so a second meal period was also owed; § 226.7 caps recovery at one meal premium per workday.'
          : '';

      premiums.push({
        type: 'meal',
        statute: STATUTE_PREMIUM,
        workday,
        amount,
        explanation:
          `A ${hoursText}-hour workday. California owes a 30-minute unpaid meal period for work over 5 hours.` +
          recordCaveat +
          second +
          cannotKnow,
      });
    }

    if (includeRest && restPeriodsOwed(day.hours) >= 1) {
      const owed = restPeriodsOwed(day.hours);
      premiums.push({
        type: 'rest',
        statute: STATUTE_PREMIUM,
        workday,
        amount,
        explanation:
          `A ${hoursText}-hour workday owed ${owed} paid 10-minute rest period${owed === 1 ? '' : 's'} (one per 4 hours worked or major fraction thereof); § 226.7 caps recovery at one rest premium per workday.` +
          ' Rest periods are PAID, so they never appear in clock records whether taken or not.' +
          cannotKnow,
      });
    }
  }

  return premiums;
}

/** Trims trailing zeros so a 6-hour day reads "6" and a 7.5-hour day reads "7.5". */
function formatHours(hours) {
  return String(Number(hours.toFixed(2)));
}
