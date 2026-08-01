#!/usr/bin/env node
/**
 * Phase 1 end-to-end smoke test.
 *
 * Exercises shifts and workplaces together against a running API. The two
 * routers were built independently against docs/contracts.md, so the cases
 * that matter most here are the ones that span both of them.
 *
 *   API_URL=http://localhost:3001 node scripts/phase1-smoke.js
 */
import { randomUUID } from 'node:crypto';

const API = process.env.API_URL || 'http://localhost:3001';
const worker = randomUUID();

let pass = 0;
let fail = 0;

function ok(msg) {
  console.log(`  PASS  ${msg}`);
  pass++;
}
function bad(msg, detail) {
  console.log(`  FAIL  ${msg}`);
  if (detail !== undefined) console.log(`        ${JSON.stringify(detail)}`);
  fail++;
}
function check(cond, msg, detail) {
  cond ? ok(msg) : bad(msg, detail);
}

async function call(method, path, body, workerId = worker) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(workerId ? { 'X-Worker-Id': workerId } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, body: json, raw: text };
}

const SF = { lat: 37.7749, lng: -122.4194 };
const FAR = { lat: 37.9, lng: -122.9 }; // ~44km away

console.log(`\nPhase 1 smoke test -> ${API}`);
console.log(`worker ${worker}\n`);

// --- identity --------------------------------------------------------------
console.log('identity');
check((await call('GET', '/api/shifts', undefined, null)).status === 400, 'missing X-Worker-Id -> 400');
check((await call('GET', '/api/shifts', undefined, 'not-a-uuid')).status === 400, 'malformed X-Worker-Id -> 400');

// --- workplaces ------------------------------------------------------------
console.log('\nworkplaces');
const created = await call('POST', '/api/workplaces', { label: 'Main warehouse', ...SF });
check(created.status === 201, 'create -> 201', created.body);
const wpId = created.body?.workplace?.id;
check(typeof wpId === 'number', 'workplace id is a number', created.body);

const listed = await call('GET', '/api/workplaces');
check(listed.body?.workplaces?.length === 1, 'list returns exactly the one workplace', listed.body);

check((await call('POST', '/api/workplaces', { label: '', ...SF })).status === 400, 'empty label -> 400');
check((await call('POST', '/api/workplaces', { label: 'x', lat: 1e999, lng: 0 })).status === 400, 'infinite lat -> 400');
check((await call('POST', '/api/workplaces', { label: 'x', lat: 91, lng: 0 })).status === 400, 'lat out of range -> 400');

// --- clock in / out --------------------------------------------------------
console.log('\nclock in / out');
const ci = await call('POST', '/api/shifts/clock-in', { gps: SF });
check(ci.status === 201, 'clock-in -> 201', ci.body);
check(ci.body?.shift?.offsiteFlag === false, 'on-site: offsiteFlag false', ci.body?.shift);
check(ci.body?.shift?.workplaceId === wpId, 'matched to the workplace', ci.body?.shift);
check(ci.body?.shift?.clockOut === null, 'open shift has null clockOut');

const dup = await call('POST', '/api/shifts/clock-in', { gps: SF });
check(dup.status === 409, 'second clock-in while open -> 409', dup.status);

const co = await call('POST', '/api/shifts/clock-out', { gps: SF });
check(co.status === 201, 'clock-out -> 201', co.body);

const afterOut = await call('GET', '/api/shifts');
check(afterOut.body?.shifts?.length === 1, 'supersession collapsed to ONE shift', afterOut.body?.shifts?.length);
check(afterOut.body?.openShift === null, 'no open shift after clock-out');
check(afterOut.body?.shifts?.[0]?.clockOut !== null, 'collapsed shift carries clockOut');

// --- GPS is optional -------------------------------------------------------
console.log('\nGPS optional (mobile workers have no fixed site)');
const noGps = await call('POST', '/api/shifts/clock-in', {});
check(noGps.status === 201, 'clock-in with NO gps -> 201', noGps.body);
check(noGps.body?.shift?.offsiteFlag === false, 'no gps is not "off-site", just unknown', noGps.body?.shift);
check(noGps.body?.shift?.distanceM === null, 'no gps -> null distance');
await call('POST', '/api/shifts/clock-out', {});

// --- off-site is flagged, never blocked ------------------------------------
console.log('\noff-site flagged not blocked');
const far = await call('POST', '/api/shifts/clock-in', { gps: FAR });
check(far.status === 201, 'far-away clock-in still ACCEPTED', far.status);
check(far.body?.shift?.offsiteFlag === true, 'flagged as off-site', far.body?.shift);
check(far.body?.shift?.distanceM > 40000, 'distance ~44km recorded', far.body?.shift?.distanceM);
await call('POST', '/api/shifts/clock-out', {});

// --- retroactive -----------------------------------------------------------
console.log('\nretroactive entry');
const retro = await call('POST', '/api/shifts/retroactive', {
  clockIn: '2026-07-20T15:00:00.000Z',
  clockOut: '2026-07-20T23:00:00.000Z',
  gps: null,
});
check(retro.status === 201, 'retroactive -> 201', retro.body);
check(retro.body?.shift?.isRetroactive === true, 'marked isRetroactive');
check(
  new Date(retro.body?.shift?.createdAt) > new Date('2026-07-21'),
  'createdAt is NOW, not the claimed date -- the gap is the point',
  retro.body?.shift?.createdAt
);
check(
  (await call('POST', '/api/shifts/retroactive', { clockIn: '2026-07-20T23:00:00.000Z', clockOut: '2026-07-20T15:00:00.000Z' })).status === 400,
  'clockOut before clockIn -> 400'
);
check(
  (await call('POST', '/api/shifts/retroactive', { clockIn: '2099-01-01T00:00:00.000Z', clockOut: '2099-01-01T08:00:00.000Z' })).status === 400,
  'future dates -> 400'
);

// --- chain integrity -------------------------------------------------------
console.log('\nchain integrity');
const verify = await call('GET', '/api/shifts/verify');
check(verify.body?.valid === true, 'chain valid', verify.body);
check(verify.body?.entryCount > 0, 'entryCount reported', verify.body?.entryCount);
check(/^[0-9a-f]{64}$/.test(verify.body?.latestHash || ''), 'latestHash is 64 hex chars', verify.body?.latestHash);

// --- THE CROSS-ROUTER CASE -------------------------------------------------
// Built by two independent agents; this is where a mismatch would surface.
console.log('\ndeleting a workplace must not rewrite history');
const del = await call('DELETE', `/api/workplaces/${wpId}`);
check(del.status === 204, 'delete -> 204', del.status);
check((await call('GET', '/api/workplaces')).body?.workplaces?.length === 0, 'gone from the worker list');

const histAfter = await call('GET', '/api/shifts');
const oldest = histAfter.body?.shifts?.find((s) => s.workplaceId === wpId);
check(!!oldest, 'past shift still references the deleted workplace', histAfter.body?.shifts?.map((s) => s.workplaceId));
check(oldest?.workplaceLabel === 'Main warehouse', 'past shift STILL resolves its label', oldest?.workplaceLabel);

const afterDelIn = await call('POST', '/api/shifts/clock-in', { gps: SF });
check(afterDelIn.body?.shift?.workplaceId === null, 'NEW clock-in no longer matches the deleted workplace', afterDelIn.body?.shift);
await call('POST', '/api/shifts/clock-out', {});

check((await call('GET', '/api/shifts/verify')).body?.valid === true, 'chain still valid after all of that');

// --- isolation -------------------------------------------------------------
console.log('\nworker isolation');
const other = randomUUID();
check((await call('GET', '/api/shifts', undefined, other)).body?.shifts?.length === 0, 'another worker sees no shifts');
check((await call('DELETE', `/api/workplaces/${wpId}`, undefined, other)).status === 404, "cannot delete another worker's workplace -> 404");

// --- malformed JSON (the bug the workplaces agent surfaced) ----------------
console.log('\nmalformed request bodies');
const badJson = await fetch(`${API}/api/workplaces`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Worker-Id': worker },
  body: '{not json',
});
check(badJson.status === 400, 'malformed JSON -> 400, not 500', badJson.status);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
