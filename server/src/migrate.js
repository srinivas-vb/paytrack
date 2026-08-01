import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { pool } from './db.js';

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(here, '..', '..', 'db', 'schema.sql');

/**
 * Applies db/schema.sql on boot.
 *
 * Safe to run every start: the schema is fully idempotent (CREATE TABLE IF NOT
 * EXISTS, CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS before CREATE).
 *
 * Doing this in-process rather than as a manual step means the deployed service
 * reaches the database over Render's INTERNAL network, which is not subject to
 * the Postgres IP allow-list. No allow-list entry to maintain, and no way to
 * deploy a service against a database that hasn't been migrated.
 *
 * Never throws -- a migration failure logs loudly and leaves the process up so
 * /health can report db:false rather than crash-looping.
 */
export async function migrate() {
  if (!process.env.DATABASE_URL) {
    console.warn('[migrate] DATABASE_URL not set -- skipping');
    return false;
  }

  try {
    const sql = await readFile(schemaPath, 'utf8');
    await pool.query(sql);

    const { rows } = await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name
    `);
    console.log(`[migrate] schema applied -- tables: ${rows.map((r) => r.table_name).join(', ')}`);
    return true;
  } catch (err) {
    console.error('[migrate] FAILED:', err.message);
    return false;
  }
}
