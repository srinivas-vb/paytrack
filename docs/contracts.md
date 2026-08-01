# Phase 1 API contract

**This file is the source of truth.** Backend and frontend are built in
parallel against it. If something here is wrong, fix it *here first*, then fix
the code — do not let the two drift.

All request/response bodies are JSON. All timestamps are ISO 8601 UTC strings.
All money-free numeric fields are plain JSON numbers.

## Identity

There is no auth in this prototype (deliberate scope cut — see README). The
client generates a UUID once, stores it in `localStorage` under `paytrack.workerId`,
and sends it on every request as the header:

```
X-Worker-Id: <uuid>
```

Requests without a valid UUID header get `400 {"error":"missing or invalid X-Worker-Id"}`.

## Shapes

### Workplace

```jsonc
{
  "id": 1,
  "label": "Main warehouse",
  "lat": 37.7749,
  "lng": -122.4194,
  "createdAt": "2026-08-01T18:00:00.000Z"
}
```

### Shift

```jsonc
{
  "id": 12,
  "workplaceId": 1,          // null if none matched or no GPS given
  "workplaceLabel": "Main warehouse", // null likewise; convenience for the UI
  "clockIn": "2026-08-01T15:00:00.000Z",
  "clockOut": "2026-08-01T23:30:00.000Z", // null while shift is open
  "gpsLat": 37.7749,         // null if GPS not supplied
  "gpsLng": -122.4194,       // null likewise
  "distanceM": 34,           // null if GPS or workplaces absent
  "offsiteFlag": false,      // true only when a nearest workplace exists AND is beyond the radius
  "isRetroactive": false,    // true when entered after the fact
  "prevHash": "0000...",     // 64 hex chars
  "entryHash": "9f2b...",    // 64 hex chars
  "createdAt": "2026-08-01T15:00:02.117Z" // SERVER time — the legally load-bearing field
}
```

Note `createdAt` vs `clockIn`. `clockIn` is what the worker *claims*.
`createdAt` is when the server *received* the claim. For a contemporaneous
entry these are seconds apart; for a retroactive one they can be weeks apart,
and that gap is exactly what `isRetroactive` makes explicit rather than hiding.

## Endpoints

### `GET /api/workplaces`
→ `200 { "workplaces": Workplace[] }`

### `POST /api/workplaces`
```jsonc
{ "label": "Main warehouse", "lat": 37.7749, "lng": -122.4194 }
```
- `label` required, 1–100 chars
- `lat` −90..90, `lng` −180..180, both required

→ `201 { "workplace": Workplace }` · `400 { "error": string }`

### `DELETE /api/workplaces/:id`
→ `204` · `404 { "error": "not found" }`

Deleting a workplace does **not** alter past shifts — `hours_log` is
append-only and historical `workplace_id` references stay as they were.

---

### `GET /api/shifts`
Newest first.

Query: `?limit=` (1–200, default 50)

→ `200 { "shifts": Shift[], "openShift": Shift | null }`

`openShift` is the single shift with `clockOut === null`, if any. The UI needs
this to decide whether to show "Clock in" or "Clock out", so the server
computes it rather than making the client scan.

### `POST /api/shifts/clock-in`
```jsonc
{ "gps": { "lat": 37.7749, "lng": -122.4194 } }  // gps optional, may be omitted or null
```
- Fails with `409 { "error": "a shift is already open", "openShift": Shift }`
  if one is already open. One open shift per worker at a time.
- Computes nearest workplace, `distanceM`, `offsiteFlag` via `lib/geo.js`.
- Computes `entryHash` via `lib/hash.js` chained off the worker's latest entry.

→ `201 { "shift": Shift }`

### `POST /api/shifts/clock-out`
```jsonc
{ "gps": { "lat": ..., "lng": ... } }  // optional
```

**The ledger is append-only, so this cannot UPDATE the open row.** Clock-out
writes a *new* entry carrying the same `clockIn` plus a `clockOut`. The open
shift is the most recent entry for that worker whose `clockOut` is null; a
later entry with the same `clockIn` and a non-null `clockOut` supersedes it.
`GET /api/shifts` must collapse these pairs so the UI sees one completed shift,
not two rows.

- `404 { "error": "no open shift" }` if none is open.

→ `201 { "shift": Shift }`

### `POST /api/shifts/retroactive`
```jsonc
{
  "clockIn":  "2026-07-20T15:00:00.000Z",
  "clockOut": "2026-07-20T23:00:00.000Z",
  "gps": null
}
```
- Both timestamps required, `clockOut > clockIn`, neither in the future.
- Always sets `isRetroactive: true`.
- This doubles as the demo-seeding mechanism — you cannot demo a wage
  discrepancy using hours logged during the hackathon.

→ `201 { "shift": Shift }` · `400 { "error": string }`

### `GET /api/shifts/verify`
Walks the worker's whole chain via `verifyChain()`.

→ `200`
```jsonc
{
  "valid": true,
  "entryCount": 14,
  "brokenAt": null,       // entry id where the chain first breaks
  "reason": null,
  "latestHash": "9f2b..."
}
```

## Rules every implementer must honour

1. **Never UPDATE or DELETE `hours_log`.** The Postgres trigger will reject it.
   Corrections are new rows.
2. **`created_at` is always server-generated.** Never accept it from a client.
3. **Chain per worker.** A worker's first entry uses `GENESIS_HASH`; every
   later one chains off *that worker's* latest `entry_hash`.
4. **Clock-in and clock-out must be atomic** — read the chain head and insert
   in one transaction, or two quick taps produce two entries claiming the same
   `prevHash` and the verifier will report a fork.
5. **Use `lib/hash.js` and `lib/geo.js`.** Do not reimplement either.

---

# Phase 2 API contract — rule engine

Legal rules live in `docs/wage-rules.md`. Hand-computed expected values live in
`server/src/rules/fixtures.js`. **Both are authoritative over any code.**

## Internal shapes (module boundaries)

### `Workday`
Produced by the bucketer, consumed by the jurisdiction rules.

```jsonc
{
  "date": "2026-07-06",        // local calendar date, YYYY-MM-DD
  "hours": 9,                   // total hours in this workday
  "shiftIds": [12, 13]          // hours_log ids contributing to it
}
```

### `Workweek`

```jsonc
{
  "start": "2026-07-05T00:00:00.000Z",
  "end":   "2026-07-12T00:00:00.000Z",   // exclusive
  "workdays": [ /* Workday */ ],
  "totalHours": 45,
  "consecutiveDaysWorked": 5              // for the CA 7th-day rule
}
```

### `HourBreakdown`
What every jurisdiction module returns for one workweek. **Every hour lands in
exactly one bucket** — the three must sum to `totalHours`.

```jsonc
{
  "straightHours": 40,
  "overtimeHours": 5,       // 1.5x
  "doubleTimeHours": 0,     // 2.0x
  "reasons": [              // human-readable, shown in the PDF and the UI
    { "hours": 5, "multiplier": 1.5, "basis": "daily overtime (over 8 in a workday)", "statute": "Cal. Lab. Code § 510" }
  ]
}
```

### `PotentialPremium`
Meal/rest flags. **Never included in `owed`** — see `docs/wage-rules.md` §4.

```jsonc
{
  "type": "meal",
  "statute": "Cal. Lab. Code § 226.7",
  "workday": "2026-07-06",
  "amount": 20,
  "explanation": "A 6-hour shift with no recorded break. PayTrack cannot see whether a break was taken."
}
```

## Module interfaces

```js
// rules/workweek.js
bucketShifts(shifts, { workweekStartsOn = 0, timezone = 'UTC' }) -> Workweek[]

// rules/federal.js  and  rules/california.js  — identical signature
computeHours(workweek) -> HourBreakdown
findPotentialPremiums(workweek, hourlyRate) -> PotentialPremium[]   // federal returns []
```

Both jurisdiction modules take a single `Workweek` and are **pure** — no DB, no
clock, no I/O. That is what makes them testable against fixtures.

## Endpoints

### `POST /api/paystubs`
Manual entry. Vision extraction (Phase 3) populates the same shape.

```jsonc
{
  "periodStart": "2026-07-05",
  "periodEnd": "2026-07-18",
  "paidHours": 78,
  "paidRate": 20,
  "grossPay": 1600,
  "presentFields": ["gross_wages", "total_hours", "net_wages", "pay_period_dates"]
}
```
`presentFields` drives the § 226(a) compliance check — the nine required elements
are listed in `docs/wage-rules.md` §5. Absent ⇒ flagged, with the caveat that
absence from the *form* is not proof of absence from the *original statement*.

→ `201 { "paystub": Paystub }` · `400 { "error": string }`

### `GET /api/paystubs` → `200 { "paystubs": Paystub[] }`
### `DELETE /api/paystubs/:id` → `204`

### `GET /api/analysis?paystubId=<id>&jurisdiction=<federal|california>`
The headline endpoint.

```jsonc
{
  "jurisdiction": "california",
  "hourlyRate": 20,
  "workweeks": [
    {
      "start": "2026-07-05T00:00:00.000Z",
      "end": "2026-07-12T00:00:00.000Z",
      "totalHours": 45,
      "breakdown": { /* HourBreakdown */ },
      "owed": 950
    }
  ],
  "totalOwed": 1650,
  "totalPaid": 1600,
  "discrepancy": 50,               // owed − paid; zero or negative is a valid result
  "potentialPremiums": [ /* PotentialPremium */ ],
  "complianceFlags": [
    { "element": "employer_address", "statute": "Cal. Lab. Code § 226(a)(9)" }
  ],
  "scopeExclusions": ["tips", "commissions", "nondiscretionary bonuses"]
}
```

## Rules every implementer must honour

1. **Bucket into workweeks first, then compute.** Never compute on a pay-period
   total — see fixture `federal-biweekly-45-35`.
2. **Never pyramid overtime.** An hour is promoted once. Hours already at 1.5×
   are excluded from the weekly straight-time total — see fixture
   `ca-nine-hour-days`.
3. **`straightHours + overtimeHours + doubleTimeHours === totalHours`**, always.
4. **Potential premiums stay out of `owed`.**
5. **Zero and negative discrepancies are correct results** and must render as
   plainly as positive ones.
6. **Money is computed in cents** internally and rounded once at the boundary.
   Never accumulate floats across a loop.
