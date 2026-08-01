import { useEffect, useState } from 'react'
import * as api from '../api.js'
import { geolocationSupported, requestPosition } from '../geo.js'
import {
  formatDayLabel,
  formatDuration,
  formatMeters,
  formatStopwatch,
  formatTime,
  shiftDurationMs,
  toDate,
} from '../format.js'
import { ErrorBlock, LoadingBlock, Notice } from './Ui.jsx'

/**
 * The one screen that has to work when someone is tired, rushed, and holding a
 * phone in one hand: a single primary action, as large as we can justify.
 */
export default function ClockPanel({
  status,
  error,
  openShift,
  onChanged,
  onRetry,
  onAddPastShift,
}) {
  const [shareLocation, setShareLocation] = useState(geolocationSupported())
  const [pending, setPending] = useState(null) // 'in' | 'out' | null
  const [notice, setNotice] = useState(null)
  const [now, setNow] = useState(() => Date.now())

  const startedAt = toDate(openShift?.clockIn)
  const startedMs = startedAt ? startedAt.getTime() : null

  useEffect(() => {
    if (startedMs === null) return undefined
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [startedMs])

  async function handleClock(kind) {
    setPending(kind)
    setNotice(null)

    // Location is corroboration, never a gate. We ask, we wait at most a few
    // seconds, and then we log the shift either way.
    let gps = null
    let locationNote = null
    if (shareLocation) {
      const fix = await requestPosition()
      if (fix.ok) {
        gps = { lat: fix.lat, lng: fix.lng }
      } else {
        locationNote = fix.message
        if (fix.code === 'denied' || fix.code === 'unsupported') {
          setShareLocation(false)
        }
      }
    }

    try {
      const shift =
        kind === 'in' ? await api.clockIn(gps) : await api.clockOut(gps)
      await onChanged()

      if (kind === 'in') {
        setNotice({
          tone: 'good',
          title: `Clocked in at ${formatTime(shift?.clockIn)}.`,
          body: locationNote,
        })
      } else {
        const worked = formatDuration(shiftDurationMs(shift))
        setNotice({
          tone: 'good',
          title: `Clocked out at ${formatTime(shift?.clockOut)} — ${worked} recorded.`,
          body: locationNote,
        })
      }
    } catch (err) {
      // The two conflicts the contract names are not really errors from the
      // worker's point of view — the screen was just out of date.
      if (err instanceof api.ApiError && err.status === 409) {
        await onChanged()
        setNotice({
          tone: 'warn',
          title: 'A shift was already open.',
          body: 'Your record is refreshed below. Nothing was lost.',
        })
      } else if (err instanceof api.ApiError && err.status === 404) {
        await onChanged()
        setNotice({
          tone: 'warn',
          title: 'No shift was open to close.',
          body: 'Your record is refreshed below.',
        })
      } else {
        setNotice({
          tone: 'bad',
          title: 'That did not save.',
          body: api.describeError(err),
        })
      }
    } finally {
      setPending(null)
    }
  }

  if (status === 'loading') {
    return (
      <section className="card">
        <h2>Right now</h2>
        <LoadingBlock>Checking whether you are clocked in…</LoadingBlock>
      </section>
    )
  }

  if (status === 'error' && !openShift) {
    return (
      <section className="card">
        <h2>Right now</h2>
        <ErrorBlock
          error={error}
          onRetry={onRetry}
          title="Could not check your shift"
        />
      </section>
    )
  }

  const isOpen = Boolean(openShift)
  const busy = pending !== null

  return (
    <>
      <section className="card clock-card">
        <h2>Right now</h2>

        {isOpen ? (
          <div className="clock-state open">
            <p className="clock-state-label">You are clocked in</p>
            <p className="stopwatch" aria-live="off">
              {formatStopwatch(now - startedMs)}
            </p>
            <p className="clock-meta">
              Started {formatTime(openShift.clockIn)} ·{' '}
              {formatDayLabel(openShift.clockIn)}
            </p>
            {openShift.workplaceLabel ? (
              <p className="clock-meta">
                At {openShift.workplaceLabel}
                {formatMeters(openShift.distanceM)
                  ? ` · ${formatMeters(openShift.distanceM)} away`
                  : ''}
              </p>
            ) : null}
          </div>
        ) : (
          <div className="clock-state">
            <p className="clock-state-label">You are not clocked in</p>
            <p className="clock-meta">
              Tap the button when your shift starts. You can add a shift you
              already worked at any time.
            </p>
          </div>
        )}

        <button
          type="button"
          className="btn btn-primary btn-big"
          onClick={() => handleClock(isOpen ? 'out' : 'in')}
          disabled={busy}
        >
          {busy ? 'Saving…' : isOpen ? 'Clock out' : 'Clock in'}
        </button>

        <label className="toggle">
          <input
            type="checkbox"
            checked={shareLocation}
            onChange={(e) => setShareLocation(e.target.checked)}
            disabled={!geolocationSupported() || busy}
          />
          <span>
            Attach my location <span className="dim">(optional)</span>
            <span className="toggle-hint">
              {geolocationSupported()
                ? 'Location supports your account of where you were. It is not proof, and clocking in works without it.'
                : 'This browser cannot share a location. Everything else still works.'}
            </span>
          </span>
        </label>

        {notice ? (
          <Notice
            tone={notice.tone}
            title={notice.title}
            onDismiss={() => setNotice(null)}
          >
            {notice.body}
          </Notice>
        ) : null}

        {status === 'error' ? (
          <p className="hint">
            The last refresh failed — what you see may be out of date.{' '}
            <button type="button" className="btn-link" onClick={onRetry}>
              Refresh
            </button>
          </p>
        ) : null}
      </section>

      <section className="card muted">
        <h2>Worked a shift already?</h2>
        <p className="hint">
          Most people find this app after months of short pay. Add those shifts
          — they count, and the record shows honestly that you entered them
          later.
        </p>
        <button type="button" className="btn" onClick={onAddPastShift}>
          Add a past shift
        </button>
      </section>
    </>
  )
}
