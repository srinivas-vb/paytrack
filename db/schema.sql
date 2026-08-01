-- PayTrack schema
-- Run once against your Render Postgres instance:  npm run db:init

-- ---------------------------------------------------------------------------
-- workplaces: worker-defined locations. The employer never writes here.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workplaces (
  id         BIGSERIAL PRIMARY KEY,
  worker_id  UUID NOT NULL,
  label      TEXT NOT NULL,
  lat        DOUBLE PRECISION,
  lng        DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Soft delete. hours_log.workplace_id references this table, so a workplace
-- that any shift has ever used cannot be physically removed -- the evidence
-- ledger must keep resolving the label it was recorded against. Hiding a
-- workplace from the worker's list and preserving it for historical lookup are
-- different things, and deleted_at names that state directly.
--
-- ON DELETE SET NULL on the FK would be the wrong fix: it rewrites hours_log
-- rows, which is exactly what an append-only ledger exists to prevent.
ALTER TABLE workplaces ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS workplaces_worker_idx ON workplaces (worker_id);

-- ---------------------------------------------------------------------------
-- hours_log: the append-only evidence ledger.
--
-- created_at is the legally load-bearing field. A row landing in third-party
-- Postgres at time T is a contemporaneous record -- that is what shifts the
-- burden under Anderson v. Mt. Clemens Pottery Co., 328 U.S. 680 (1946).
--
-- The hash chain's job is to distinguish contemporaneous entries from
-- retroactive ones, not to make the record unforgeable.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hours_log (
  id             BIGSERIAL PRIMARY KEY,
  worker_id      UUID NOT NULL,
  workplace_id   BIGINT REFERENCES workplaces(id),
  clock_in       TIMESTAMPTZ NOT NULL,
  clock_out      TIMESTAMPTZ,
  gps_lat        DOUBLE PRECISION,
  gps_lng        DOUBLE PRECISION,
  distance_m     DOUBLE PRECISION,
  offsite_flag   BOOLEAN NOT NULL DEFAULT FALSE,
  is_retroactive BOOLEAN NOT NULL DEFAULT FALSE,
  prev_hash      TEXT,
  entry_hash     TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hours_log_worker_idx ON hours_log (worker_id, clock_in);

-- ---------------------------------------------------------------------------
-- Append-only enforcement.
--
-- Honest framing for the demo: a superuser could DROP this trigger. The claim
-- is "the application's own credentials cannot rewrite history", not "this is
-- physically immutable". Say it that way -- judges respect the precision.
--
-- A bare REVOKE UPDATE, DELETE would also work, but the trigger demos better:
-- it raises a visible exception you can show on screen.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION prevent_modification() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'hours_log is append-only. Modification blocked.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS block_updates ON hours_log;
CREATE TRIGGER block_updates
  BEFORE UPDATE OR DELETE ON hours_log
  FOR EACH ROW EXECUTE FUNCTION prevent_modification();

-- ---------------------------------------------------------------------------
-- notarizations: written nightly by the Render Cron Job.
--
-- Deliberately a SEPARATE table so the cron never trips the append-only
-- trigger on hours_log.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notarizations (
  id           BIGSERIAL PRIMARY KEY,
  worker_id    UUID NOT NULL,
  latest_hash  TEXT NOT NULL,
  entry_count  INTEGER NOT NULL,
  notarized_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notarizations_worker_idx ON notarizations (worker_id, notarized_at);

-- ---------------------------------------------------------------------------
-- paystubs: extracted via vision LLM, Tesseract fallback, or manual entry.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS paystubs (
  id                      BIGSERIAL PRIMARY KEY,
  worker_id               UUID NOT NULL,
  period_start            DATE,
  period_end              DATE,
  paid_hours              NUMERIC(10, 2),
  paid_rate               NUMERIC(10, 2),
  gross_pay               NUMERIC(12, 2),
  image_bytes             BYTEA,
  extraction_confidence   TEXT,
  extraction_source       TEXT CHECK (extraction_source IN ('llm', 'tesseract', 'manual')),
  missing_required_fields TEXT[],           -- CA Labor Code s 226 compliance
  raw_llm_json            JSONB,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS paystubs_worker_idx ON paystubs (worker_id, period_start);
