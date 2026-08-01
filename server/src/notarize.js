import { pool } from './db.js';

/**
 * Notarize-on-write: the free-tier fallback for the Render Cron Job.
 *
 * Records a worker's current chain head with a SERVER timestamp. Call it after
 * any write to hours_log.
 *
 * How this compares to the cron:
 *   cron                 proves chain state at a fixed time, whether or not
 *                        the worker did anything that day
 *   notarize-on-write    proves chain state at the moment the worker acted
 *
 * Both timestamps are server-issued and neither can be forged by the worker's
 * device -- which is the property that matters. The cron is strictly stronger
 * because it is independent of worker activity, but this is not a fig leaf.
 *
 * Throttled to at most one row per worker per THROTTLE_MS so a busy day does
 * not write hundreds of near-identical notarizations.
 */
const THROTTLE_MS = 60 * 60 * 1000; // 1 hour

export async function maybeNotarize(workerId) {
  try {
    const { rows: recent } = await pool.query(
      `SELECT notarized_at FROM notarizations
       WHERE worker_id = $1
       ORDER BY notarized_at DESC
       LIMIT 1`,
      [workerId]
    );

    if (recent.length > 0) {
      const age = Date.now() - new Date(recent[0].notarized_at).getTime();
      if (age < THROTTLE_MS) return { notarized: false, reason: 'throttled' };
    }

    const { rows: head } = await pool.query(
      `SELECT entry_hash, (SELECT count(*) FROM hours_log WHERE worker_id = $1) AS entry_count
       FROM hours_log
       WHERE worker_id = $1
       ORDER BY id DESC
       LIMIT 1`,
      [workerId]
    );

    if (head.length === 0) return { notarized: false, reason: 'no entries' };

    const { rows: written } = await pool.query(
      `INSERT INTO notarizations (worker_id, latest_hash, entry_count)
       VALUES ($1, $2, $3)
       RETURNING notarized_at`,
      [workerId, head[0].entry_hash, Number(head[0].entry_count)]
    );

    return { notarized: true, at: written[0].notarized_at };
  } catch (err) {
    // Never let notarization failure break a clock-in. The ledger write is the
    // thing that matters; this is corroboration on top of it.
    console.error('[notarize] failed:', err.message);
    return { notarized: false, reason: err.message };
  }
}
