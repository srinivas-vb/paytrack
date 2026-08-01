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

/**
 * "$1,600.00" — money, always to the cent.
 *
 * Negative amounts get a real minus sign in front of the currency symbol
 * ("−$50.00") rather than the locale's parenthesised accounting form, because a
 * negative discrepancy is an ordinary, correct answer here and must read as a
 * plain number, not as an error state.
 */
export function formatMoney(value) {
  if (!Number.isFinite(value)) return '—'
  const abs = Math.abs(value).toLocaleString([], {
    style: 'currency',
    currency: 'USD',
  })
  return value < 0 ? `−${abs}` : abs
}

/** "45h" / "8.5h" — hours as a worker would say them, never "8.50". */
export function formatHours(value) {
  if (!Number.isFinite(value)) return '—'
  return `${Number(value.toFixed(2))}h`
}

/** "1.5×" — the multiplier, without trailing zeros. */
export function formatMultiplier(value) {
  if (!Number.isFinite(value)) return '—'
  return `${Number(value.toFixed(2))}×`
}

/**
 * Formats a bare `YYYY-MM-DD` calendar date.
 *
 * Deliberately NOT `new Date('2026-07-05')` — the spec says a date-only string
 * is parsed as UTC midnight, so rendering it in any zone west of UTC prints the
 * PREVIOUS day. A pay period that displays as starting a day earlier than the
 * worker typed would quietly undermine the one document they're checking
 * against.
 */
export function formatCalendarDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '')
  if (!m) return '—'
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return invalid(d)
    ? '—'
    : d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })
}

/**
 * A workweek's human label — "Sun, 5 Jul – Sat, 11 Jul".
 *
 * `end` is EXCLUSIVE in the contract, so naming it directly would print a day
 * outside the week. The last day is therefore derived from `start` plus the
 * span in whole days, rather than from `end` minus an instant. Two reasons:
 *
 *   - Adding CALENDAR days is DST-safe. Adding 6×86,400,000 ms across a spring
 *     transition lands at 01:00 the following day.
 *   - Both ends of the label then come from the same anchor. The workweek
 *     boundaries are computed in the worker's configured zone but rendered in
 *     the device's; when those differ, `end − 1ms` can fall on the far side of
 *     local midnight and print an eight-day week. This cannot.
 */
/**
 * Labels a workweek using the SAME calendar the rule engine bucketed it on.
 *
 * The engine buckets at 00:00 UTC (see rules/workweek.js). Rendering those
 * boundary instants in the viewer's local zone shifts them: west of UTC, a
 * workweek beginning Sunday 00:00 UTC is Saturday 17:00 local, so the label
 * read "Sat, Jul 4 – Fri, Jul 10" for a week that starts on a Sunday and
 * contains no Saturday shift. The dates were off by one and the weekday name
 * contradicted the rule being applied.
 *
 * So the boundaries are formatted in UTC. The end instant is EXCLUSIVE, so the
 * last day shown is the span minus one -- otherwise a 7-day week prints an
 * 8-day range.
 *
 * report.js does the same thing for the same reason; the two must agree,
 * because a worker comparing the screen to the PDF is checking exactly this.
 */
export function formatWeekRange(startIso, endIso) {
  const start = toDate(startIso)
  if (!start) return '—'

  const end = toDate(endIso)
  const spanDays = end
    ? Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000))
    : 7

  const last = new Date(start.getTime() + (spanDays - 1) * 86_400_000)
  return `${formatUtcDayLabel(start)} – ${formatUtcDayLabel(last)}`
}

/** A day label rendered on the UTC calendar, not the viewer's. */
function formatUtcDayLabel(d) {
  return d.toLocaleDateString([], {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  })
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
