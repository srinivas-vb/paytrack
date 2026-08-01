/**
 * Workweek / workday bucketing.
 *
 * The single most important rule in docs/wage-rules.md §1: overtime is computed
 * per workweek and NEVER averaged across weeks. Everything downstream depends on
 * the buckets produced here being right, so this module does one job — turn a
 * flat list of shifts into fixed, recurring 168-hour workweeks, each subdivided
 * into fixed, recurring 24-hour workdays running from local midnight.
 *
 * Two splits matter and both are implemented:
 *
 *   - A shift crossing local midnight is split across two WORKDAYS. Federal law
 *     has no daily overtime, but California does (§510), and the bucketer is
 *     shared. A 22:00–06:00 shift is 2h on one workday and 6h on the next; a
 *     bucketer that assigned all 8h to the clock-in date would silently
 *     misreport daily overtime.
 *   - A shift crossing the workweek boundary is split across two WORKWEEKS, for
 *     exactly the same reason — the hours after the boundary belong to the next
 *     week's 40-hour count, not this one's.
 *
 * Pure: no DB, no clock, no I/O. Time arithmetic is done in integer
 * milliseconds and converted to hours once, at the end, so nothing accumulates
 * float error across a loop.
 */

const MS_PER_HOUR = 3_600_000;

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const pad2 = (n) => String(n).padStart(2, '0');

const isoDate = (year, month, day) => `${year}-${pad2(month)}-${pad2(day)}`;

/** Trim float dust from an hours figure without pretending to more precision. */
const roundHours = (hours) => Math.round(hours * 1e6) / 1e6;

/**
 * A formatter bound to one IANA timezone. All local-wall-clock questions
 * ("what date is it there?", "when is midnight there?") go through this, which
 * is what makes the module correct across DST rather than only in UTC.
 */
function zoneFormatter(timezone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  });
}

/** Local wall-clock components of an instant, in the formatter's timezone. */
function localParts(zone, ts) {
  const parts = zone.formatToParts(new Date(ts));
  const get = (type) => parts.find((p) => p.type === type).value;
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: WEEKDAY_INDEX[get('weekday')],
  };
}

/** Offset of the timezone at `ts`, in ms (local minus UTC). */
function offsetMs(zone, ts) {
  const p = localParts(zone, ts);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ts;
}

/**
 * The instant of local midnight on a given local calendar date.
 *
 * Solved by iteration because the offset depends on the answer: guess with the
 * offset at the naive instant, then correct with the offset at the guess. Two
 * passes converge for every real-world zone. On a spring-forward day where
 * 00:00 does not exist locally this lands on the first instant of the day,
 * which is the behaviour we want for a boundary.
 */
function localMidnight(zone, year, month, day) {
  const naive = Date.UTC(year, month - 1, day, 0, 0, 0);
  const firstGuess = naive - offsetMs(zone, naive);
  return naive - offsetMs(zone, firstGuess);
}

/** Calendar-date arithmetic (not 24h arithmetic — DST days are 23h or 25h). */
function addCalendarDays(year, month, day, delta) {
  const t = new Date(Date.UTC(year, month - 1, day + delta));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

/** The workday (local midnight → next local midnight) containing `ts`. */
function workdayBounds(zone, ts) {
  const p = localParts(zone, ts);
  const next = addCalendarDays(p.year, p.month, p.day, 1);
  return {
    date: isoDate(p.year, p.month, p.day),
    start: localMidnight(zone, p.year, p.month, p.day),
    end: localMidnight(zone, next.year, next.month, next.day),
  };
}

/** The workweek (168 hours from the designated local weekday) containing `ts`. */
function workweekBounds(zone, ts, workweekStartsOn) {
  const p = localParts(zone, ts);
  const back = (p.weekday - workweekStartsOn + 7) % 7;
  const first = addCalendarDays(p.year, p.month, p.day, -back);
  const after = addCalendarDays(first.year, first.month, first.day, 7);
  return {
    start: localMidnight(zone, first.year, first.month, first.day),
    end: localMidnight(zone, after.year, after.month, after.day),
  };
}

/**
 * Buckets shifts into workweeks and workdays.
 *
 * OPEN SHIFTS ARE SKIPPED. A shift with `clockOut === null` is a worker who is
 * still on the clock; it is neither zero hours nor hours-up-to-now. Treating it
 * as zero would understate the claim, and running it to `Date.now()` would make
 * this module impure and make the same input produce a different answer every
 * time it is analysed — fatal for a record meant to be evidence.
 *
 * @param {Array<{id?:number, clockIn:string|number|Date, clockOut:string|number|Date|null}>} shifts
 * @param {{workweekStartsOn?: number, timezone?: string}} [options]
 *        workweekStartsOn: 0 = Sunday .. 6 = Saturday (FLSA lets the employer
 *        designate this; PayTrack defaults to Sunday 00:00 local).
 * @returns {Array<{start:string, end:string, workdays:Array<{date:string,hours:number,shiftIds:Array}>, totalHours:number, consecutiveDaysWorked:number}>}
 */
export function bucketShifts(shifts, { workweekStartsOn = 0, timezone = 'UTC' } = {}) {
  if (!Number.isInteger(workweekStartsOn) || workweekStartsOn < 0 || workweekStartsOn > 6) {
    throw new RangeError(`workweekStartsOn must be an integer 0-6, got ${workweekStartsOn}`);
  }

  const zone = zoneFormatter(timezone); // throws on an unknown IANA zone

  // weekStartTs -> { start, end, days: Map<dateString, { ms, shiftIds: Set }> }
  const weeks = new Map();

  for (const shift of shifts ?? []) {
    // Open shift: no clock-out yet. Skip entirely — see the note above.
    if (shift == null || shift.clockOut == null) continue;

    const start = new Date(shift.clockIn).getTime();
    const end = new Date(shift.clockOut).getTime();

    // Unparseable or non-positive duration contributes nothing. Defensive only:
    // the API layer rejects clockOut <= clockIn on the way in.
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;

    let cursor = start;
    while (cursor < end) {
      const day = workdayBounds(zone, cursor);
      const week = workweekBounds(zone, cursor, workweekStartsOn);

      // The segment ends at whichever comes first: the shift's own end, the
      // next local midnight, or the workweek boundary. This is the split.
      const segmentEnd = Math.min(end, day.end, week.end);
      if (segmentEnd <= cursor) {
        throw new Error(`workweek bucketing failed to advance at ${new Date(cursor).toISOString()}`);
      }

      let bucket = weeks.get(week.start);
      if (!bucket) {
        bucket = { start: week.start, end: week.end, days: new Map() };
        weeks.set(week.start, bucket);
      }

      let workday = bucket.days.get(day.date);
      if (!workday) {
        workday = { ms: 0, shiftIds: new Set() };
        bucket.days.set(day.date, workday);
      }

      workday.ms += segmentEnd - cursor; // integer ms; converted to hours once, later
      if (shift.id !== undefined && shift.id !== null) workday.shiftIds.add(shift.id);

      cursor = segmentEnd;
    }
  }

  return [...weeks.values()]
    .sort((a, b) => a.start - b.start)
    .map((bucket) => {
      const workdays = [...bucket.days.entries()]
        .filter(([, d]) => d.ms > 0)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([date, d]) => ({
          date,
          hours: roundHours(d.ms / MS_PER_HOUR),
          shiftIds: [...d.shiftIds],
        }));

      const totalMs = [...bucket.days.values()].reduce((sum, d) => sum + d.ms, 0);

      return {
        start: new Date(bucket.start).toISOString(),
        end: new Date(bucket.end).toISOString(), // exclusive
        workdays,
        totalHours: roundHours(totalMs / MS_PER_HOUR),
        // Days worked within this workweek. Inside a single 168-hour week,
        // "worked all seven days" and "worked seven consecutive days" are the
        // same statement, so this count is the correct trigger for the
        // California 7th-day rule (Cal. Lab. Code § 510) — a week with any gap
        // cannot reach seven.
        consecutiveDaysWorked: workdays.length,
      };
    });
}
