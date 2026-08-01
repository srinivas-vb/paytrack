/**
 * Hand-computed wage fixtures. THE SPEC — write these before the implementation.
 *
 * Every `expected` value here was computed by hand from docs/wage-rules.md, not
 * produced by running the code. That is the entire point: an engine that agrees
 * with itself proves nothing.
 *
 * Each fixture carries a `wrongAnswer` where a plausible bug produces a specific
 * incorrect number. If a run ever yields the wrong answer instead of the right
 * one, the regression is unmistakable rather than "the total looks a bit off".
 *
 * All timestamps are UTC and all workweeks start Sunday 00:00 UTC, so fixtures
 * are timezone-independent. Real workers get a local workweek boundary.
 *
 * Base rate is $20.00/hr throughout — chosen so every expected figure is exact
 * in cents and can be checked mentally.
 *
 *   2026-07-05 is a Sunday (verified), so workweeks run Sun 07-05 → Sat 07-11
 *   and Sun 07-12 → Sat 07-18.
 */

export const RATE = 20;

/** Shorthand: a shift on `date` from `startHour` for `hours` hours, UTC. */
function shift(date, startHour, hours) {
  const pad = (n) => String(n).padStart(2, '0');
  const start = new Date(`${date}T${pad(startHour)}:00:00.000Z`);
  const end = new Date(start.getTime() + hours * 3600_000);
  return { clockIn: start.toISOString(), clockOut: end.toISOString() };
}

export const fixtures = [
  // -------------------------------------------------------------------------
  {
    id: 'federal-single-week-45h',
    description: '45 hours in one workweek, federal FLSA',
    jurisdiction: 'federal',
    hourlyRate: RATE,
    shifts: [
      shift('2026-07-06', 9, 9),
      shift('2026-07-07', 9, 9),
      shift('2026-07-08', 9, 9),
      shift('2026-07-09', 9, 9),
      shift('2026-07-10', 9, 9),
    ],
    expected: {
      totalHours: 45,
      straightHours: 40,
      overtimeHours: 5,
      doubleTimeHours: 0,
      // 40 × $20 = $800  +  5 × $30 = $150
      owed: 950,
    },
    note: 'Baseline. Federal has no daily overtime, so five 9-hour days is simply 45 weekly hours.',
  },

  // -------------------------------------------------------------------------
  {
    id: 'federal-biweekly-45-35',
    description: 'Biweekly period: 45h then 35h — the averaging trap',
    jurisdiction: 'federal',
    hourlyRate: RATE,
    shifts: [
      // Workweek 1 — 45 hours
      shift('2026-07-06', 9, 9),
      shift('2026-07-07', 9, 9),
      shift('2026-07-08', 9, 9),
      shift('2026-07-09', 9, 9),
      shift('2026-07-10', 9, 9),
      // Workweek 2 — 35 hours
      shift('2026-07-13', 9, 7),
      shift('2026-07-14', 9, 7),
      shift('2026-07-15', 9, 7),
      shift('2026-07-16', 9, 7),
      shift('2026-07-17', 9, 7),
    ],
    expected: {
      totalHours: 80,
      straightHours: 75,
      overtimeHours: 5,
      doubleTimeHours: 0,
      // Week 1: 40 × $20 + 5 × $30 = $950
      // Week 2: 35 × $20            = $700
      owed: 1650,
      perWorkweekOwed: [950, 700],
    },
    wrongAnswer: {
      owed: 1600,
      producedBy:
        'Computing on the 80-hour pay-period total. 80 hours over two weeks averages to 40/week, so it reports ZERO overtime and understates by $50.',
    },
    note: 'THE case. Overtime never averages across workweeks. Bucket first, then compute.',
  },

  // -------------------------------------------------------------------------
  {
    id: 'ca-nine-hour-days',
    description: 'Five 9-hour days in California — the double-count trap',
    jurisdiction: 'california',
    hourlyRate: RATE,
    shifts: [
      shift('2026-07-06', 9, 9),
      shift('2026-07-07', 9, 9),
      shift('2026-07-08', 9, 9),
      shift('2026-07-09', 9, 9),
      shift('2026-07-10', 9, 9),
    ],
    expected: {
      totalHours: 45,
      straightHours: 40,
      overtimeHours: 5, // daily OT only
      doubleTimeHours: 0,
      // Step 1: each day → 8 straight + 1 at 1.5×.  Totals: 40 straight, 5 OT.
      // Step 2: straight-time total is 40, NOT over 40 → no weekly OT added.
      // 40 × $20 = $800  +  5 × $30 = $150
      owed: 950,
    },
    wrongAnswer: {
      owed: 1100,
      producedBy:
        'Counting 5 hours of daily OT AND 5 hours of weekly OT (45 − 40). California does not pyramid: hours already promoted to 1.5× must be excluded from the weekly straight-time total. Overstates by $150.',
    },
    note: 'Same hours and same total as the federal fixture, reached by a completely different path.',
  },

  // -------------------------------------------------------------------------
  {
    id: 'ca-thirteen-hour-day',
    description: 'Single 13-hour day in California — double time',
    jurisdiction: 'california',
    hourlyRate: RATE,
    shifts: [shift('2026-07-06', 6, 13)],
    expected: {
      totalHours: 13,
      straightHours: 8,
      overtimeHours: 4, // hours 8–12
      doubleTimeHours: 1, // hour 12–13
      // 8 × $20 = $160  +  4 × $30 = $120  +  1 × $40 = $40
      owed: 320,
    },
    note: 'Exercises the 12-hour double-time boundary. Weekly total is 13h, so no weekly OT interaction.',
  },

  // -------------------------------------------------------------------------
  {
    id: 'ca-seventh-consecutive-day',
    description: 'Seven consecutive 8-hour days in California',
    jurisdiction: 'california',
    hourlyRate: RATE,
    shifts: [
      shift('2026-07-05', 9, 8), // Sun — day 1 of the workweek
      shift('2026-07-06', 9, 8),
      shift('2026-07-07', 9, 8),
      shift('2026-07-08', 9, 8),
      shift('2026-07-09', 9, 8),
      shift('2026-07-10', 9, 8),
      shift('2026-07-11', 9, 8), // Sat — 7th consecutive day
    ],
    expected: {
      totalHours: 56,
      straightHours: 40,
      overtimeHours: 16, // 8 weekly (from days 1–6) + 8 from the 7th-day rule
      doubleTimeHours: 0, // nobody exceeded 8 hours in a day
      // Days 1–6 contribute 48 straight-time hours; 8 of those convert to 1.5×.
      // Day 7's 8 hours are promoted to 1.5× directly and excluded from step 2.
      // 40 × $20 = $800  +  16 × $30 = $480
      owed: 1280,
    },
    note: '7th-day hours are promoted directly and must NOT also be counted in the weekly straight-time total.',
  },

  // -------------------------------------------------------------------------
  {
    id: 'federal-long-day-no-overtime',
    description: '13h day + four 3h days = 25h — federal owes no overtime',
    jurisdiction: 'federal',
    hourlyRate: RATE,
    shifts: [
      shift('2026-07-06', 6, 13),
      shift('2026-07-07', 9, 3),
      shift('2026-07-08', 9, 3),
      shift('2026-07-09', 9, 3),
      shift('2026-07-10', 9, 3),
    ],
    expected: {
      totalHours: 25,
      straightHours: 25,
      overtimeHours: 0,
      doubleTimeHours: 0,
      owed: 500, // 25 × $20
    },
    note: 'Federal has NO daily overtime. A 13-hour day earns nothing extra if the week stays under 40.',
  },

  // -------------------------------------------------------------------------
  {
    id: 'ca-long-day-same-hours',
    description: 'Identical shifts to the previous fixture, under California law',
    jurisdiction: 'california',
    hourlyRate: RATE,
    shifts: [
      shift('2026-07-06', 6, 13),
      shift('2026-07-07', 9, 3),
      shift('2026-07-08', 9, 3),
      shift('2026-07-09', 9, 3),
      shift('2026-07-10', 9, 3),
    ],
    expected: {
      totalHours: 25,
      straightHours: 20, // 8 from the long day + 12 from the short days
      overtimeHours: 4,
      doubleTimeHours: 1,
      // 20 × $20 = $400  +  4 × $30 = $120  +  1 × $40 = $40
      owed: 560,
    },
    note: 'Same 25 hours, $60 more than federal. This pair is the clearest demonstration of why jurisdiction matters.',
  },

  // -------------------------------------------------------------------------
  {
    id: 'no-discrepancy',
    description: '40 straight hours, paid correctly — must report ZERO owed',
    jurisdiction: 'federal',
    hourlyRate: RATE,
    shifts: [
      shift('2026-07-06', 9, 8),
      shift('2026-07-07', 9, 8),
      shift('2026-07-08', 9, 8),
      shift('2026-07-09', 9, 8),
      shift('2026-07-10', 9, 8),
    ],
    expected: {
      totalHours: 40,
      straightHours: 40,
      overtimeHours: 0,
      doubleTimeHours: 0,
      owed: 800,
    },
    paystub: { paidHours: 40, paidRate: RATE, grossPay: 800 },
    expectedDiscrepancy: 0,
    note: 'A correct employer must produce zero. An engine that only ever finds violations is an accusation generator, not evidence.',
  },

  // -------------------------------------------------------------------------
  {
    id: 'ca-potential-meal-premium',
    description: '6-hour unbroken shift — POTENTIAL meal premium, not owed',
    jurisdiction: 'california',
    hourlyRate: RATE,
    shifts: [shift('2026-07-06', 9, 6)],
    expected: {
      totalHours: 6,
      straightHours: 6,
      overtimeHours: 0,
      doubleTimeHours: 0,
      owed: 120, // 6 × $20 — wages only
      potentialPremiums: [
        {
          type: 'meal',
          statute: 'Cal. Lab. Code § 226.7',
          workday: '2026-07-06',
          amount: 20, // one hour at the regular rate
        },
      ],
    },
    note:
      'MUST stay out of the headline `owed` figure. PayTrack sees clock-in and clock-out, not breaks — an unbroken 6h entry is equally consistent with a worker who took a break and did not log it. Flag and explain; never assert.',
  },
];

export const byId = Object.fromEntries(fixtures.map((f) => [f.id, f]));
