import {
  formatDateTime,
  formatDayLabel,
  formatDuration,
  formatGap,
  formatMeters,
  formatTime,
  shiftDurationMs,
  shortHash,
} from '../format.js'
import { Badge, EmptyBlock, ErrorBlock, LoadingBlock } from './Ui.jsx'
import RetroactiveForm from './RetroactiveForm.jsx'

export default function HistoryPanel({
  status,
  error,
  shifts,
  onRetry,
  onChanged,
  retroOpen,
  setRetroOpen,
}) {
  const list = shifts ?? []
  const completed = list.filter((s) => s.clockOut)
  const totalMs = completed.reduce(
    (sum, s) => sum + (shiftDurationMs(s) ?? 0),
    0,
  )

  return (
    <>
      <section className="card">
        <h2>Add a past shift</h2>
        {retroOpen ? (
          <RetroactiveForm
            onCreated={onChanged}
            onClose={() => setRetroOpen(false)}
          />
        ) : (
          <>
            <p className="hint">
              Already worked hours that are not here? Add them. They are marked
              as entered later — that gap is part of an honest record, not a
              flaw in it.
            </p>
            <button
              type="button"
              className="btn"
              onClick={() => setRetroOpen(true)}
            >
              Add a shift you already worked
            </button>
          </>
        )}
      </section>

      <section className="card">
        <h2>Your shifts</h2>

        {status === 'loading' ? (
          <LoadingBlock>Loading your shifts…</LoadingBlock>
        ) : null}

        {status === 'error' && list.length === 0 ? (
          <ErrorBlock
            error={error}
            onRetry={onRetry}
            title="Could not load your shifts"
          />
        ) : null}

        {status === 'error' && list.length > 0 ? (
          <p className="hint">
            The last refresh failed, so this list may be out of date.{' '}
            <button type="button" className="btn-link" onClick={onRetry}>
              Refresh
            </button>
          </p>
        ) : null}

        {status !== 'loading' && list.length === 0 && status !== 'error' ? (
          <EmptyBlock title="Nothing recorded yet.">
            <p>Two ways to start, and both count:</p>
            <ol className="empty-steps">
              <li>
                Clock in when your next shift starts — that gets you a
                timestamped entry the moment you begin.
              </li>
              <li>
                Add a shift you already worked, using the form above. Weeks of
                past hours can go in today.
              </li>
            </ol>
          </EmptyBlock>
        ) : null}

        {list.length > 0 ? (
          <>
            <p className="summary">
              {completed.length} completed shift
              {completed.length === 1 ? '' : 's'} ·{' '}
              <strong>{formatDuration(totalMs)}</strong> recorded
            </p>
            <ul className="shift-list">
              {list.map((shift) => (
                <ShiftRow key={shift.id} shift={shift} />
              ))}
            </ul>
          </>
        ) : null}
      </section>
    </>
  )
}

function ShiftRow({ shift }) {
  const open = !shift.clockOut
  const durationMs = shiftDurationMs(shift)
  const distance = formatMeters(shift.distanceM)
  const gap = formatGap(shift.clockIn, shift.createdAt)

  return (
    <li className={`shift${open ? ' shift-open' : ''}`}>
      <div className="shift-head">
        <span className="shift-day">{formatDayLabel(shift.clockIn)}</span>
        <span className="shift-duration">
          {open ? 'in progress' : formatDuration(durationMs)}
        </span>
      </div>

      <p className="shift-times">
        {formatTime(shift.clockIn)} –{' '}
        {shift.clockOut ? formatTime(shift.clockOut) : 'not yet clocked out'}
      </p>

      <p className="shift-where">
        {shift.workplaceLabel
          ? `${shift.workplaceLabel}${distance ? ` · ${distance} away` : ''}`
          : shift.gpsLat === null || shift.gpsLat === undefined
            ? 'No location attached'
            : 'Location recorded, no saved workplace matched'}
      </p>

      <div className="badges">
        {open ? <Badge tone="good">In progress</Badge> : null}
        {shift.offsiteFlag ? (
          <Badge
            tone="warn"
            title={
              distance
                ? `Nearest saved workplace was ${distance} away.`
                : 'Logged away from your nearest saved workplace.'
            }
          >
            Away from workplace
          </Badge>
        ) : null}
        {shift.isRetroactive ? (
          <Badge
            tone="later"
            title="Entered after the fact, not clocked in live."
          >
            Added later
          </Badge>
        ) : null}
      </div>

      <details className="shift-detail">
        <summary>Record details</summary>
        <dl>
          <dt>Saved by server</dt>
          <dd>
            {formatDateTime(shift.createdAt)}
            {gap ? ` (${gap})` : ''}
          </dd>
          <dt>Location</dt>
          <dd>
            {typeof shift.gpsLat === 'number' && typeof shift.gpsLng === 'number'
              ? `${shift.gpsLat.toFixed(5)}, ${shift.gpsLng.toFixed(5)}`
              : 'none'}
          </dd>
          <dt>Entry hash</dt>
          <dd title={shift.entryHash || ''}>{shortHash(shift.entryHash)}</dd>
          <dt>Links to</dt>
          <dd title={shift.prevHash || ''}>{shortHash(shift.prevHash)}</dd>
        </dl>
      </details>
    </li>
  )
}
