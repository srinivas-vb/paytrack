import pg from 'pg';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.warn(
    '[db] DATABASE_URL is not set. /health will report db:false until you set it.'
  );
}

// Render's managed Postgres requires SSL, but rejects the default CA chain from
// a local machine. Local Postgres (if you run one) needs SSL off entirely.
const isLocal =
  !process.env.DATABASE_URL ||
  process.env.DATABASE_URL.includes('localhost') ||
  process.env.DATABASE_URL.includes('127.0.0.1');

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  console.error('[db] idle client error:', err.message);
});

/** Cheap liveness probe used by /health. Never throws. */
export async function dbHealthy() {
  if (!process.env.DATABASE_URL) return false;
  try {
    const { rows } = await pool.query('SELECT 1 AS ok');
    return rows[0]?.ok === 1;
  } catch (err) {
    console.error('[db] health check failed:', err.message);
    return false;
  }
}

export function query(text, params) {
  return pool.query(text, params);
}
