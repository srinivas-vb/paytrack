/** Display formatting. Everything renders in the device's local time zone. */

const invalid = (d) => !(d instanceof Date) || Number.isNaN(d.getTime())

export function toDate(iso) {
  if (!iso) return null
  const d = new Date(iso)
  return invalid(d) ? null : d
}

export function formatTime(iso) {
  const d = toDate(iso)
  return d ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '—'
}

export function formatDayLabel(iso) {
  const d = toDate(iso)
  return d
    ? d.toLocaleDateString([], {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
      })
    : '—'
}

export function formatDateTime(iso) {
  const d = toDate(iso)
  return d
    ? `${d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}, ${formatTime(iso)}`
    : '—'
}

/** "8h 30m" — the shape a worker checks a paystub against. */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const totalMinutes = Math.floor(ms / 60_000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours === 0) return `${minutes}m`
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`
}

/** "07:14:03" — the ticking display for a shift in progress. */
export function formatStopwatch(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '00:00:00'
  const total = Math.floor(ms / 1000)
  const pad = (n) => String(n).padStart(2, '0')
  return [
    pad(Math.floor(total / 3600)),
    pad(Math.floor((total % 3600) / 60)),
    pad(total % 60),
  ].join(':')
}

export function shiftDurationMs(shift) {
  const start = toDate(shift?.clockIn)
  const end = toDate(shift?.clockOut)
  if (!start || !end) return null
  return end.getTime() - start.getTime()
}

export function shortHash(hash, chars = 12) {
  if (typeof hash !== 'string' || hash.length === 0) return '—'
  return hash.length <= chars ? hash : `${hash.slice(0, chars)}…`
}

export function formatMeters(m) {
  if (typeof m !== 'number' || !Number.isFinite(m)) return null
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`
}

/** "12 days later" — the honest gap between working and logging. */
export function formatGap(fromIso, toIso) {
  const from = toDate(fromIso)
  const to = toDate(toIso)
  if (!from || !to) return null
  const ms = to.getTime() - from.getTime()
  if (ms < 60_000) return 'immediately'
  const days = Math.floor(ms / 86_400_000)
  if (days >= 1) return `${days} day${days === 1 ? '' : 's'} later`
  const hours = Math.floor(ms / 3_600_000)
  if (hours >= 1) return `${hours} hour${hours === 1 ? '' : 's'} later`
  return `${Math.floor(ms / 60_000)} minutes later`
}

/** yyyy-mm-dd in LOCAL time, for <input type="date"> defaults. */
export function toDateInputValue(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * Combines a local `yyyy-mm-dd` and `HH:MM` into a Date in the device's zone.
 * Deliberately not `new Date(string)` — that parses some formats as UTC.
 */
export function fromLocalParts(dateStr, timeStr) {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '')
  const tm = /^(\d{2}):(\d{2})/.exec(timeStr || '')
  if (!dm || !tm) return null
  const d = new Date(
    Number(dm[1]),
    Number(dm[2]) - 1,
    Number(dm[3]),
    Number(tm[1]),
    Number(tm[2]),
    0,
    0,
  )
  return invalid(d) ? null : d
}
