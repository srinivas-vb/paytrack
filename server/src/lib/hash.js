import { createHash } from 'node:crypto';

/**
 * Canonical entry hash for the ledger chain.
 *
 * THIS IS A CONTRACT. Every writer must produce hashes identically or the
 * integrity verifier will report false tampering. Do not reorder fields, do
 * not change the separator, do not change null handling.
 *
 * What the chain actually proves: that entries were not reordered or edited
 * *relative to each other* after the fact. It does NOT prove the times are
 * true -- nothing on the worker's device can. The evidential weight comes from
 * `created_at` (server-issued) plus `is_retroactive`, which together establish
 * WHEN the worker made each claim. Under Anderson v. Mt. Clemens Pottery, a
 * contemporaneous record is what shifts the burden to the employer.
 *
 * Genesis entries (first for a worker) use prevHash = GENESIS_HASH.
 */
export const GENESIS_HASH = '0'.repeat(64);

const SEP = '|';

/**
 * Normalizes a value into the hash preimage.
 * null/undefined collapse to empty string so a missing GPS reading and an
 * explicitly-null one hash identically.
 */
function norm(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number') return String(v);
  return String(v);
}

/**
 * @param {object} entry
 * @param {string|Date} entry.clockIn        ISO string or Date
 * @param {string|Date|null} entry.clockOut
 * @param {number|null} entry.gpsLat
 * @param {number|null} entry.gpsLng
 * @param {number|null} entry.distanceM
 * @param {boolean} entry.offsiteFlag
 * @param {boolean} entry.isRetroactive
 * @param {string} entry.prevHash           previous entry_hash, or GENESIS_HASH
 * @returns {string} lowercase hex sha256
 */
export function computeEntryHash({
  clockIn,
  clockOut,
  gpsLat,
  gpsLng,
  distanceM,
  offsiteFlag,
  isRetroactive,
  prevHash,
}) {
  const preimage = [
    norm(clockIn),
    norm(clockOut),
    norm(gpsLat),
    norm(gpsLng),
    norm(distanceM),
    norm(offsiteFlag),
    norm(isRetroactive),
    norm(prevHash),
  ].join(SEP);

  return createHash('sha256').update(preimage, 'utf8').digest('hex');
}

/**
 * Walks a chain in insertion order and reports the first break.
 *
 * @param {Array} entries ordered by id ASC, each with the fields above plus entryHash
 * @returns {{valid: boolean, brokenAt: number|null, reason: string|null}}
 */
export function verifyChain(entries) {
  let expectedPrev = GENESIS_HASH;

  for (const e of entries) {
    if (e.prevHash !== expectedPrev) {
      return {
        valid: false,
        brokenAt: e.id,
        reason: `entry ${e.id} claims prevHash ${String(e.prevHash).slice(0, 12)}... but the chain expected ${expectedPrev.slice(0, 12)}...`,
      };
    }

    const recomputed = computeEntryHash({
      clockIn: e.clockIn,
      clockOut: e.clockOut,
      gpsLat: e.gpsLat,
      gpsLng: e.gpsLng,
      distanceM: e.distanceM,
      offsiteFlag: e.offsiteFlag,
      isRetroactive: e.isRetroactive,
      prevHash: e.prevHash,
    });

    if (recomputed !== e.entryHash) {
      return {
        valid: false,
        brokenAt: e.id,
        reason: `entry ${e.id} content does not match its hash -- it was altered after being written`,
      };
    }

    expectedPrev = e.entryHash;
  }

  return { valid: true, brokenAt: null, reason: null };
}
