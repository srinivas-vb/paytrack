#!/usr/bin/env node
/**
 * Phase 2 end-to-end smoke test.
 *
 * Seeds real shifts through the retroactive endpoint, enters a paystub, and
 * checks the analysis against hand-computed fixture values -- so this exercises
 * the whole path (DB -> supersession collapse -> bucketing -> jurisdiction
 * rules -> money) rather than the pure functions in isolation.
 *
 * The unit tests prove the rules are right. This proves the wiring is.
 *
 *   API_URL=http://localhost:3001 node scripts/phase2-smoke.js
 */
import { randomUUID } from 'node:crypto';
import { fixtures, byId } from '../server/src/rules/fixtures.js';

const API = process.env.API_URL || 'http://localhost:3001';

let pass = 0;
let fail = 0;
const ok = (m) => (console.log(`  PASS  ${m}`), pass++);
const bad = (m, d) => (
  console.log(`  FAIL  ${m}${d !== undefined ? `\n        ${JSON.stringify(d)}` : ''}`), fail++
);
const check = (c, m, d) => (c ? ok(m) : bad(m, d));

async function call(method, path, body, worker) {
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
  return { status: res.status, body: json };
}

/** Seeds a fixture's shifts as retroactive entries, returns the worker id. */
async function seed(fixture) {
  const worker = randomUUID();
  for (const s of fixture.shifts) {
    const r = await call(
      'POST',
      '/api/shifts/retroactive',
      { clockIn: s.clockIn, clockOut: s.clockOut, gps: null },
      worker
    );
    if (r.status !== 201) throw new Error(`seed failed: ${JSON.stringify(r)}`);
  }
  return worker;
}

console.log(`\nPhase 2 smoke test -> ${API}\n`);

// ---------------------------------------------------------------------------
// Every fixture, end to end through the real stack.
// ---------------------------------------------------------------------------
for (const f of fixtures) {
  console.log(`[${f.id}] (${f.jurisdiction})`);
  const worker = await seed(f);

  const stub = await call(
    'POST',
    '/api/paystubs',
    {
      periodStart: '2026-07-05',
      periodEnd: '2026-07-18',
      paidHours: f.paystub?.paidHours ?? f.expected.totalHours,
      paidRate: f.hourlyRate,
      grossPay: f.paystub?.grossPay ?? f.expected.owed,
      presentFields: [],
    },
    worker
  );
  if (stub.status !== 201) {
    bad('paystub create', stub);
    continue;
  }

  const a = await call(
    'GET',
    `/api/analysis?paystubId=${stub.body.paystub.id}&jurisdiction=${f.jurisdiction}`,
    undefined,
    worker
  );
  if (a.status !== 200) {
    bad('analysis', a);
    continue;
  }

  const r = a.body;
  const e = f.expected;
  const buckets = r.workweeks.reduce(
    (acc, w) => ({
      s: acc.s + w.breakdown.straightHours,
      o: acc.o + w.breakdown.overtimeHours,
      d: acc.d + w.breakdown.doubleTimeHours,
    }),
    { s: 0, o: 0, d: 0 }
  );

  check(buckets.s === e.straightHours, `straight ${buckets.s} == ${e.straightHours}`);
  check(buckets.o === e.overtimeHours, `overtime ${buckets.o} == ${e.overtimeHours}`);
  check(buckets.d === e.doubleTimeHours, `doubletime ${buckets.d} == ${e.doubleTimeHours}`);
  check(Math.abs(r.totalOwed - e.owed) < 0.005, `owed $${r.totalOwed} == $${e.owed}`);
  check(
    buckets.s + buckets.o + buckets.d === e.totalHours,
    `every hour counted exactly once (${e.totalHours}h)`
  );

  if (e.perWorkweekOwed) {
    const per = r.workweeks.map((w) => w.owed);
    check(
      JSON.stringify(per) === JSON.stringify(e.perWorkweekOwed),
      `per-workweek ${JSON.stringify(per)} == ${JSON.stringify(e.perWorkweekOwed)}`
    );
    check(r.workweeks.length === 2, 'split into TWO workweeks, not one pay period');
  }

  if (f.wrongAnswer) {
    check(
      Math.abs(r.totalOwed - f.wrongAnswer.owed) > 0.005,
      `did NOT produce the known-wrong $${f.wrongAnswer.owed}`
    );
  }

  if (e.expectedMealPremiums !== undefined) {
    const meals = r.potentialPremiums.filter((p) => p.type === 'meal').length;
    check(meals === e.expectedMealPremiums, `meal premiums ${meals} == ${e.expectedMealPremiums}`);
  }
  check(
    r.potentialPremiums.every((p) => typeof p.explanation === 'string'),
    'every premium explains what PayTrack cannot see'
  );

  if (f.expectedDiscrepancy !== undefined) {
    check(
      Math.abs(r.discrepancy - f.expectedDiscrepancy) < 0.005,
      `discrepancy $${r.discrepancy} == $${f.expectedDiscrepancy} (a correct employer must produce zero)`
    );
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// Cross-cutting behaviour the fixtures don't cover.
// ---------------------------------------------------------------------------
console.log('cross-cutting');
{
  const f = byId['ca-nine-hour-days'];
  const worker = await seed(f);
  const stub = await call(
    'POST',
    '/api/paystubs',
    { periodStart: '2026-07-05', periodEnd: '2026-07-18', paidHours: 45, paidRate: 20, grossPay: 900, presentFields: [] },
    worker
  );
  const id = stub.body.paystub.id;

  // Same hours, both jurisdictions -- CA must find daily OT that federal cannot.
  const fed = await call('GET', `/api/analysis?paystubId=${id}&jurisdiction=federal`, undefined, worker);
  const ca = await call('GET', `/api/analysis?paystubId=${id}&jurisdiction=california`, undefined, worker);
  check(fed.body.totalOwed === 950 && ca.body.totalOwed === 950, 'both jurisdictions agree at 45h/wk (different paths, same total)');
  check(fed.body.potentialPremiums.length === 0, 'federal reports no meal premiums');
  check(ca.body.potentialPremiums.length > 0, 'california does');

  check(
    (await call('GET', `/api/analysis?paystubId=${id}&jurisdiction=narnia`, undefined, worker)).status === 400,
    'unknown jurisdiction -> 400'
  );
  check(
    (await call('GET', `/api/analysis?paystubId=${id}`, undefined, randomUUID())).status === 404,
    "another worker cannot analyse this paystub -> 404"
  );

  // presentFields omitted entirely => "not assessed" => no compliance flags.
  const unassessed = await call(
    'POST',
    '/api/paystubs',
    { periodStart: '2026-07-05', periodEnd: '2026-07-18', paidHours: 45, paidRate: 20, grossPay: 900 },
    worker
  );
  const ua = await call('GET', `/api/analysis?paystubId=${unassessed.body.paystub.id}&jurisdiction=california`, undefined, worker);
  check(
    ua.body.complianceFlags.length === 0,
    'omitted presentFields means NOT ASSESSED, not nine violations',
    ua.body.complianceFlags
  );

  // All nine present => no flags. One missing => exactly one flag, right key.
  const eight = ['gross_wages','total_hours','piece_rate_units','deductions','net_wages','pay_period_dates','employee_name_and_id','hourly_rates'];
  const partial = await call(
    'POST',
    '/api/paystubs',
    { periodStart: '2026-07-05', periodEnd: '2026-07-18', paidHours: 45, paidRate: 20, grossPay: 900, presentFields: eight },
    worker
  );
  const pa = await call('GET', `/api/analysis?paystubId=${partial.body.paystub.id}&jurisdiction=california`, undefined, worker);
  check(pa.body.complianceFlags.length === 1, `exactly one missing element flagged, got ${pa.body.complianceFlags.length}`, pa.body.complianceFlags);
  check(
    pa.body.complianceFlags[0]?.element === 'employer_name_and_address',
    'the flagged key matches the vocabulary paystubs.js stores',
    pa.body.complianceFlags[0]
  );
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
