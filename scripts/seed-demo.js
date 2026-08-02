#!/usr/bin/env node
/**
 * Seeds a realistic wage-theft scenario for demos and manual testing.
 *
 * The story: a warehouse worker in California puts in ten 9-hour days across
 * two workweeks. Their employer pays 80 hours flat -- shorting 10 hours and
 * paying no overtime at all. California owes daily overtime past 8 hours in a
 * workday, so the gap is larger than the missing hours alone suggest.
 *
 *   logged   90h  (2 workweeks x 5 days x 9h)
 *   owed   $1900  (per week: 40 straight x $20 + 5 OT x $30 = $950)
 *   paid   $1600  (80h x $20, no overtime)
 *   short   $300
 *
 * Deliberately included so the demo shows the honest edges as well as the
 * headline:
 *   - one off-site clock-in, flagged and NOT blocked
 *   - one shift with no GPS at all, which is not the same as off-site
 *   - every entry retroactive, since a worker who has already been shorted for
 *     weeks is exactly who this app is for
 *   - a paystub missing two s 226(a) elements, so compliance flags appear
 *
 *   API_URL=http://localhost:3001 node scripts/seed-demo.js
 */
import { randomUUID } from 'node:crypto';

const API = process.env.API_URL || 'http://localhost:3001';
const RATE = 20;
const worker = process.env.WORKER_ID || randomUUID();

const WAREHOUSE = { lat: 37.7749, lng: -122.4194 };
const ELSEWHERE = { lat: 37.9, lng: -122.9 }; // ~44km away

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Worker-Id': worker },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  if (res.status >= 400) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return json;
}

const at = (date, hour, hours) => {
  const start = new Date(`${date}T${String(hour).padStart(2, '0')}:00:00.000Z`);
  return {
    clockIn: start.toISOString(),
    clockOut: new Date(start.getTime() + hours * 3600_000).toISOString(),
  };
};

console.log(`\nSeeding demo data\n  API:    ${API}\n  worker: ${worker}\n`);

await call('POST', '/api/workplaces', { label: 'Main warehouse', ...WAREHOUSE });
console.log('  workplace: Main warehouse');

// Two workweeks of 9-hour days. Sunday 2026-07-05 starts workweek one.
const days = [
  '2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10',
  '2026-07-13', '2026-07-14', '2026-07-15', '2026-07-16', '2026-07-17',
];

for (const [i, date] of days.entries()) {
  // Day 8 is off-site (covering another location); day 4 has no GPS at all.
  const gps = i === 7 ? ELSEWHERE : i === 3 ? null : WAREHOUSE;
  await call('POST', '/api/shifts/retroactive', { ...at(date, 9, 9), gps });
}
console.log(`  shifts:    ${days.length} retroactive 9-hour days (1 off-site, 1 with no GPS)`);

// The employer's claim. 80 hours flat, no overtime line at all -- and the
// statement is missing the employer address and the per-rate hours breakdown.
const stub = await call('POST', '/api/paystubs', {
  periodStart: '2026-07-05',
  periodEnd: '2026-07-18',
  paidHours: 80,
  paidRate: RATE,
  grossPay: 1600,
  presentFields: [
    'gross_wages',
    'total_hours',
    'deductions',
    'net_wages',
    'pay_period_dates',
    'employee_name_and_id',
    'piece_rate_units',
  ],
});
console.log(`  paystub:   80h @ $${RATE} = $1600 (missing 2 of the nine s 226(a) elements)`);

// ---------------------------------------------------------------------------
// Second pay period: the one where the jurisdiction toggle changes the answer.
//
// Scenario one is honest but it makes a poor argument for supporting two
// jurisdictions, because the two agree: 9h x 5 gives five overtime hours
// whether you reach them daily (California) or weekly (federal), so the
// discrepancy is $300 either way and the toggle moves nothing but flags.
//
// Four 10-hour days is the case that separates them. The week totals 40 hours,
// so FEDERAL LAW SEES NO VIOLATION AT ALL -- 40 is the threshold and the worker
// did not cross it. California counts overtime by the day, so each of those
// days owes 2 hours at 1.5x.
//
//   logged   40h  (1 workweek x 4 days x 10h)
//   federal $800  (40 straight x $20 -- nothing owed, paid in full)
//   calif.  $880  (32 straight x $20 + 8 daily OT x $30)
//   paid    $800
//   short     $0 federal / $80 California
//
// This is the strongest single beat available: same worker, same hours, same
// employer, one toggle, and a violation appears out of nothing. It is also the
// honest one -- it is exactly why "which state" is a question the app has to
// ask rather than a setting it can guess.
// ---------------------------------------------------------------------------
const COMPRESSED = ['2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23'];
for (const date of COMPRESSED) {
  await call('POST', '/api/shifts/retroactive', { ...at(date, 8, 10), gps: WAREHOUSE });
}

const stub2 = await call('POST', '/api/paystubs', {
  periodStart: '2026-07-19',
  periodEnd: '2026-07-25',
  paidHours: 40,
  paidRate: RATE,
  grossPay: 800,
  // This employer filled the statement in correctly. The point of the scenario
  // is the overtime rule, not paperwork -- and an app that finds a violation on
  // every document it sees is an accusation generator, not evidence.
  presentFields: [
    'gross_wages',
    'total_hours',
    'deductions',
    'net_wages',
    'pay_period_dates',
    'employee_name_and_id',
    'employer_name_and_address',
    'hourly_rates',
    'piece_rate_units',
  ],
});
console.log(`  shifts:    ${COMPRESSED.length} retroactive 10-hour days (one workweek, 40h total)`);
console.log(`  paystub:   40h @ $${RATE} = $800 (all nine s 226(a) elements present)`);

const ca = await call('GET', `/api/analysis?paystubId=${stub.paystub.id}&jurisdiction=california`);
const fed = await call('GET', `/api/analysis?paystubId=${stub.paystub.id}&jurisdiction=federal`);
const ca2 = await call('GET', `/api/analysis?paystubId=${stub2.paystub.id}&jurisdiction=california`);
const fed2 = await call('GET', `/api/analysis?paystubId=${stub2.paystub.id}&jurisdiction=federal`);

console.log(`
  Period 1 -- Jul 5-18, ten 9-hour days, employer paid 80h flat
    California  owed $${ca.totalOwed}  paid $${ca.totalPaid}  short $${ca.discrepancy}
    Federal     owed $${fed.totalOwed}  paid $${fed.totalPaid}  short $${fed.discrepancy}
    workweeks:  ${ca.workweeks.length}   premiums flagged: ${ca.potentialPremiums.length}   compliance flags: ${ca.complianceFlags.length}

  Period 2 -- Jul 19-25, four 10-hour days, employer paid all 40h
    California  owed $${ca2.totalOwed}  paid $${ca2.totalPaid}  short $${ca2.discrepancy}
    Federal     owed $${fed2.totalOwed}  paid $${fed2.totalPaid}  short $${fed2.discrepancy}
    ^ the toggle demo: federal sees nothing, California finds $${ca2.discrepancy}

To see this in the browser, open the console at http://localhost:5173 and run:

  localStorage.setItem('paytrack.workerId', '${worker}')

then reload.
`);
