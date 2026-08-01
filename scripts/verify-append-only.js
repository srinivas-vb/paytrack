#!/usr/bin/env node
/**
 * Proves the ledger refuses its own edits.
 *
 * This is your demo's best beat -- run it live on stage. It inserts a throwaway
 * entry, tries to UPDATE it, tries to DELETE it, and shows Postgres rejecting
 * both. Written in Node rather than psql so there's nothing extra to install.
 *
 *   DATABASE_URL="postgres://..." npm run db:verify
 */
import 'dotenv/config';
import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
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

const workerId = randomUUID();
const hash = createHash('sha256').update(`verify-${workerId}`).digest('hex');
let passed = 0;
let failed = 0;

function ok(msg) {
  console.log(`  PASS  ${msg}`);
  passed++;
}
function bad(msg) {
  console.log(`  FAIL  ${msg}`);
  failed++;
}

try {
  console.log('\nAppend-only ledger verification\n');

  // 1. INSERT must succeed -- the ledger accepts new history.
  const { rows } = await client.query(
    `INSERT INTO hours_log (worker_id, clock_in, clock_out, entry_hash)
     VALUES ($1, now() - interval '8 hours', now(), $2)
     RETURNING id, created_at`,
    [workerId, hash]
  );
  const { id, created_at } = rows[0];
  ok(`INSERT accepted (id=${id}, server created_at=${created_at.toISOString()})`);

  // 2. UPDATE must be rejected by the trigger.
  try {
    await client.query(`UPDATE hours_log SET clock_out = now() WHERE id = $1`, [id]);
    bad('UPDATE was ALLOWED -- the trigger is missing. Re-run npm run db:init');
  } catch (err) {
    if (err.message.includes('append-only')) {
      ok(`UPDATE rejected: "${err.message}"`);
    } else {
      bad(`UPDATE failed for the wrong reason: ${err.message}`);
    }
  }

  // 3. DELETE must be rejected by the trigger.
  try {
    await client.query(`DELETE FROM hours_log WHERE id = $1`, [id]);
    bad('DELETE was ALLOWED -- the trigger is missing. Re-run npm run db:init');
  } catch (err) {
    if (err.message.includes('append-only')) {
      ok(`DELETE rejected: "${err.message}"`);
    } else {
      bad(`DELETE failed for the wrong reason: ${err.message}`);
    }
  }

  // 4. The notarizations table must NOT be blocked -- the nightly cron writes
  //    there, and it would be trapped by the trigger if it shared a table.
  try {
    await client.query(
      `INSERT INTO notarizations (worker_id, latest_hash, entry_count) VALUES ($1, $2, 1)`,
      [workerId, hash]
    );
    ok('notarizations accepts writes (cron will not trip the trigger)');
  } catch (err) {
    bad(`notarizations INSERT failed: ${err.message}`);
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
} finally {
  await client.end();
}

process.exit(failed > 0 ? 1 : 0);
