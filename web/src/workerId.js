/**
 * Worker identity.
 *
 * There is no auth in this prototype (deliberate scope cut). The client mints
 * one UUID, keeps it in localStorage under `paytrack.workerId`, and sends it on
 * every request as `X-Worker-Id`. Losing it means losing access to the record,
 * which is worth saying out loud in the UI rather than hiding.
 */

const STORAGE_KEY = 'paytrack.workerId'
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

let cached = null
// null = not decided yet, false = localStorage refused (private mode, blocked
// cookies). We surface that, because an id that dies with the tab is a record
// the worker cannot come back to.
let persisted = null

function randomUuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  // crypto.randomUUID needs a secure context. Over plain http on a LAN (a very
  // normal way to test on a phone) it is simply absent, so fall back rather
  // than crash.
  const bytes = new Uint8Array(16)
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40 // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80 // variant 10

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-')
}

function readStored() {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function writeStored(value) {
  try {
    localStorage.setItem(STORAGE_KEY, value)
    return true
  } catch {
    return false
  }
}

/** The caller's worker id. Stable for the life of the browser profile. */
export function getWorkerId() {
  if (cached) return cached

  const stored = readStored()
  if (stored && UUID_RE.test(stored)) {
    cached = stored
    persisted = true
    return cached
  }

  cached = randomUuid()
  persisted = writeStored(cached)
  return cached
}

/** False when this id will vanish with the tab, so the UI can warn. */
export function workerIdIsPersisted() {
  if (persisted === null) getWorkerId()
  return persisted !== false
}
