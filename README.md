# PayTrack

**Your hours. Your record. Your evidence.**

Employers steal an estimated $15–50B/year from U.S. workers — more than all
robberies, burglaries, and motor vehicle theft combined. Under 3% is ever
recovered. The root cause is structural: **the only record of hours worked is
controlled by the employer.**

PayTrack gives workers an independent one. Log your own hours, photograph your
paystub, and see — in dollars — the gap between what you worked and what you
were paid.

## Live

| | |
|---|---|
| App | https://paytrack-web.onrender.com |
| API | https://paytrack-api-eoya.onrender.com |
| Health | https://paytrack-api-eoya.onrender.com/api/health |

Note the `-eoya` suffix on the API — `paytrack-api` was already taken on
Render, so the generated URL differs from the service name.

## Why this works legally

Under **_Anderson v. Mt. Clemens Pottery Co._, 328 U.S. 680 (1946)**, when an
employer fails to keep the records required by FLSA § 211(c), the worker need
only show the amount of work "as a matter of just and reasonable inference" —
and **the burden shifts to the employer to rebut it.**

This is the whole point. The worker's record does *not* need to be unforgeable.
It needs to be **reasonable and contemporaneous**. That is what PayTrack
produces: a timestamped, third-party-held, tamper-evident log.

Being precise about the limits is part of the pitch, not a concession:

- GPS can be spoofed. It's a plausibility signal that strengthens with
  consistency across many entries, not cryptographic proof.
- Self-reported time isn't automatically legally binding. It strengthens a
  worker's case; it doesn't guarantee a ruling.
- The append-only trigger means *the application's own credentials cannot
  rewrite history* — not that the data is physically immutable.

## Quick start

```bash
npm install
cp .env.example .env          # fill in DATABASE_URL
npm run dev                   # API :3001 + web :5173
```

Open http://localhost:5173 — the page reports whether the API and database are
reachable.

**The schema applies itself on boot.** `db/schema.sql` is idempotent and runs
on every start, so there's no migration step to forget. In production this
happens over Render's internal network, which the Postgres IP allow-list does
not gate — so no allow-list entry to maintain as your laptop's IP changes.

```bash
npm run db:verify    # prove the ledger refuses UPDATE and DELETE
```

`db:verify` is your demo's best beat. Run it live. Running it **from your
laptop** needs your IP in the Postgres allow-list (Render dashboard → the
database → Access Control); the deployed service doesn't, because it connects
internally.

## Deploying to Render

1. **Authorize GitHub for this repo.** Render can't fetch a private repo
   otherwise, and this is a browser flow with no API equivalent:
   dashboard → **New → Web Service** → **Connect GitHub** → grant access.
2. Dashboard → **New → Blueprint** → select the repo. `render.yaml` provisions
   Postgres, the API, and the static site — all on free plans.
3. Set the values Render won't sync from git:
   - `paytrack-api` → `GEMINI_API_KEY`, `ALLOWED_ORIGINS` = the static site URL
   - `paytrack-web` → `VITE_API_URL` = the API URL

### Notarization on the free tier

Render Cron Jobs require a paid plan, so the blueprint ships with the cron
commented out and the API falls back to **notarize-on-write**
(`server/src/notarize.js`), throttled to one notarization per worker per hour.

Be precise about the difference when you pitch it: the cron proves chain state
at a fixed time regardless of worker activity; notarize-on-write only records
state when the worker acts. Both timestamps are server-issued and neither is
forgeable by the worker's device. The cron is strictly stronger, and
uncommenting it in `render.yaml` is a one-line change once you're on a paid plan.

### Three things that will bite you

- **Free Postgres expires 30 days after creation.** Fine for a hackathon.
- **Free web services spin down after ~15 min idle**, with a 30–60s cold start.
  Hit the URL right before you present.
- **CORS** is configured but only enforced once `ALLOWED_ORIGINS` is set. Unset
  means "allow all" — fine in dev, wrong in production.

## Architecture

Everything below runs on Render's **free** tier — two services and one managed
database. Nothing here is aspirational; this is what is deployed.

```
Static Site (Render, free) ── React + Vite
      ↓ HTTPS · image downscaled ~1568px client-side
Web Service (Render, free) ── Express · GEMINI_API_KEY lives here ONLY
      ├→ Gemini vision  → structured paystub JSON   (gemini-flash-latest)
      ├→ Gemini text    → plain-language explainer  (gemini-flash-lite-latest)
      ├→ rule engine    → per-workweek discrepancy
      └→ Postgres (Render, free) ── append-only ledger, refuses its own UPDATEs
             ↑
             └─ notarize-on-write, throttled 1/worker/hour
                (stands in for the cron job — see below)
```

**Three resources, each with a reason it can't be swapped out.** The vision LLM
is what makes the Web Service structurally necessary — it is the only place the
API key can ever live. Postgres is not storage here but an evidence ledger: a
trigger makes it refuse UPDATE and DELETE from the application's own
credentials.

The two LLM calls deliberately use **different models**. Gemini's free tier
meters requests per model rather than per key, so sharing one would let
rehearsing the explainer exhaust the quota that paystub extraction depends on —
and extraction is the feature with no fallback.

### What is *not* running, and why

`render.yaml` also contains a **cron job** and a **background worker**, both
commented out. Both require a paid plan, so neither is deployed:

| Service | Purpose | Status |
|---|---|---|
| `paytrack-notarize` (cron) | nightly chain notarization, 08:00 UTC | commented out — paid plan |
| `paytrack-worker` | backfill queue for bulk paystub extraction | commented out — paid plan, and the queue itself is unbuilt |

The cron is replaced by **notarize-on-write** (`server/src/notarize.js`). The
honest difference: the cron proves chain state at a fixed time regardless of
whether the worker did anything; notarize-on-write only records state when the
worker acts. Both timestamps are server-issued and neither is forgeable by the
worker's device, so this is a weaker guarantee rather than a fig leaf.
Uncommenting the cron is a one-line change on a paid plan.

## Layout

```
db/schema.sql              tables + append-only trigger
server/src/index.js        Express app, CORS, health probes
server/src/db.js           pg pool, SSL handling for Render
server/src/notarize.js     notarize-on-write fallback, throttled 1/worker/hour
server/src/jobs/notarize.js  the cron entrypoint (not deployed — paid plan)
scripts/db-init.js         apply schema
scripts/verify-append-only.js  prove the ledger rejects edits
web/                       Vite + React
render.yaml                Render blueprint
```

## Scope

Supported: **federal FLSA + California**, hourly non-exempt workers, single
employer, weekly or biweekly pay periods aligned to workweek boundaries.

Not supported: tips, commissions, nondiscretionary bonuses (which change the
"regular rate" under 29 C.F.R. § 778), semi-monthly pay periods, other states.

Overtime is computed **per workweek** — a fixed, recurring 168-hour period. It
does not average across weeks. A biweekly stub covering 45h and 35h owes 5
hours of overtime, not zero.

---

**Prototype. Not legal advice, and not a substitute for a lawyer or your state
labor agency.**
