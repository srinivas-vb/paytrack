#!/usr/bin/env node
/**
 * Applies db/schema.sql to whatever DATABASE_URL points at.
 * Idempotent -- safe to re-run.
 *
 *   DATABASE_URL="postgres://..." npm run db:init
 */
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(here, '..', 'db', 'schema.sql');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
  console.error('Copy it from the Render dashboard (External Database URL) and retry:');
  console.error('  DATABASE_URL="postgres://..." npm run db:init');
  process.exit(1);
}

const isLocal =
  process.env.DATABASE_URL.includes('localhost') ||
  process.env.DATABASE_URL.includes('127.0.0.1');

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});

const sql = await readFile(schemaPath, 'utf8');

await client.connect();
console.log('connected');

try {
  await client.query(sql);
  console.log('schema applied');

  const { rows } = await client.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' ORDER BY table_name
  `);
  console.log('tables:', rows.map((r) => r.table_name).join(', '));
} finally {
  await client.end();
}
