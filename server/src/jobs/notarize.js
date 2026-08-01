#!/usr/bin/env node
/**
 * Nightly notarization -- run by the Render Cron Job.
 *
 * For each worker with ledger entries, records their latest chain hash and
 * entry count with a SERVER timestamp. This is the piece the worker's own
 * device cannot forge: proof the chain existed in this state as of this date,
 * held by a third party.
 *
 * Writes to `notarizations`, deliberately a separate table, so it never trips
 * the append-only trigger on hours_log.
 *
 * Run locally:  DATABASE_URL="postgres://..." node server/src/jobs/notarize.js
 */
import 'dotenv/config';
import pg from 'pg';

if (!process.env.DATABASE_URL) {
  console.error('[notarize] DATABASE_URL is not set');
  process.exit(1);
}

const isLocal =
  process.env.DATABASE_URL.includes('localhost') ||
  process.env.DATABASE_URL.includes('127.0.0.1');

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});

await client.connect();

try {
  // DISTINCT ON gives the newest entry per worker in one pass.
  const { rows } = await client.query(`
    SELECT DISTINCT ON (worker_id)
           worker_id,
           entry_hash,
           (SELECT count(*) FROM hours_log h2 WHERE h2.worker_id = h1.worker_id) AS entry_count
    FROM hours_log h1
    ORDER BY worker_id, id DESC
  `);

  if (rows.length === 0) {
    console.log('[notarize] no ledger entries yet -- nothing to notarize');
  }

  for (const row of rows) {
    await client.query(
      `INSERT INTO notarizations (worker_id, latest_hash, entry_count)
       VALUES ($1, $2, $3)`,
      [row.worker_id, row.entry_hash, Number(row.entry_count)]
    );
    console.log(
      `[notarize] worker=${row.worker_id} entries=${row.entry_count} hash=${row.entry_hash.slice(0, 12)}...`
    );
  }

  console.log(`[notarize] done -- ${rows.length} worker(s) notarized`);
} catch (err) {
  console.error('[notarize] failed:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
