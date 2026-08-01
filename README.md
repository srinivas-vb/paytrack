# PayTrack

**Your hours. Your record. Your evidence.**

Employers steal an estimated $15–50B/year from U.S. workers — more than all
robberies, burglaries, and motor vehicle theft combined. Under 3% is ever
recovered. The root cause is structural: **the only record of hours worked is
controlled by the employer.**

PayTrack gives workers an independent one. Log your own hours, photograph your
paystub, and see — in dollars — the gap between what you worked and what you
were paid.

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

Once `DATABASE_URL` is set:

```bash
npm run db:init      # apply db/schema.sql (idempotent)
npm run db:verify    # prove the ledger refuses UPDATE and DELETE
```

`db:verify` is your demo's best beat. Run it live.

## Deploying to Render

1. Push to GitHub.
2. Render dashboard → **New → Blueprint** → select the repo. `render.yaml`
   provisions Postgres, the API, the static site, and the notarization cron.
3. **Check whether the cron job deployed.** Cron Jobs have historically been a
   paid Render feature, and the entire notarization layer depends on it. Find
   out on day one — the fallback (notarize-on-write in the API) is a much
   weaker independence story and you want time to adapt the pitch.
4. Set the secrets Render won't sync from git:
   - `paytrack-api` → `ANTHROPIC_API_KEY`, and `ALLOWED_ORIGINS` = the static
     site URL
   - `paytrack-web` → `VITE_API_URL` = the API URL
5. Run `npm run db:init` locally against the **External Database URL**.

### Two things that will bite you on demo day

- **Free web services spin down after ~15 min idle**, with a 30–60s cold start.
  Hit the URL right before you present.
- **CORS** between the static site and API is already configured, but it only
  works once `ALLOWED_ORIGINS` is actually set. Unset means "allow all", which
  is fine in dev and wrong in production.

## Architecture

```
Static Site (Render) ── React + Vite
      ↓ HTTPS · image downscaled ~1568px client-side
Web Service (Render) ── Express · ANTHROPIC_API_KEY lives here ONLY
      ├→ Anthropic vision API → structured paystub JSON
      ├→ rule engine → per-workweek discrepancy
      └→ Postgres (Render) ── append-only ledger, refuses its own UPDATEs
Background Worker (Render) ──→ backfill queue        (Phase 4)
Cron Job (Render) ───────────→ nightly notarization
```

Four services, each with a reason it can't be swapped out. The vision LLM is
what makes the Web Service structurally necessary — it is the only place the
API key can ever live.

## Layout

```
db/schema.sql              tables + append-only trigger
server/src/index.js        Express app, CORS, health probes
server/src/db.js           pg pool, SSL handling for Render
server/src/jobs/notarize.js  nightly cron: latest hash per worker
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
