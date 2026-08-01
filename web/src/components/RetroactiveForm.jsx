import { useMemo, useState } from 'react'
import * as api from '../api.js'
import {
  formatDayLabel,
  formatDuration,
  formatTime,
  fromLocalParts,
  toDateInputValue,
} from '../format.js'
import { Notice } from './Ui.jsx'

/**
 * Adding a past shift is a first-class action, not a repair tool. A worker who
 * has already been underpaid for months has nothing to log in real time yet —
 * this form is how their case gets built, and how a demo gets its history.
 */
export default function RetroactiveForm({ onCreated, onClose }) {
  const today = useMemo(() => toDateInputValue(), [])
  const [date, setDate] = useState(today)
  const [start, setStart] = useState('09:00')
  const [end, setEnd] = useState('17:00')
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState(null)

  const parsed = useMemo(() => {
    const startAt = fromLocalParts(date, start)
    let endAt = fromLocalParts(date, end)
    if (!startAt || !endAt) return { error: null, startAt: null, endAt: null }

    // Overnight shifts are normal in the trades this app is for. If the end
    // time is at or before the start, read it as the next morning.
    let overnight = false
    if (endAt.getTime() <= startAt.getTime()) {
      endAt = new Date(endAt.getTime() + 86_400_000)
      overnight = true
    }

    if (endAt.getTime() > Date.now()) {
      return {
        error: 'That shift ends in the future. Check the date and times.',
        startAt,
        endAt,
        overnight,
      }
    }

    return { error: null, startAt, endAt, overnight }
  }, [date, start, end])

  const ready = Boolean(parsed.startAt && parsed.endAt && !parsed.error)
  const durationMs = ready ? parsed.endAt - parsed.startAt : null

  async function handleSubmit(event) {
    event.preventDefault()
    if (!ready || saving) return

    setSaving(true)
    setNotice(null)
    try {
      const shift = await api.addRetroactiveShift({
        clockIn: parsed.startAt.toISOString(),
        clockOut: parsed.endAt.toISOString(),
        gps: null,
      })
      await onCreated()
      setNotice({
        tone: 'good',
        title: `Added ${formatDayLabel(shift?.clockIn ?? parsed.startAt.toISOString())}, ${formatTime(
          shift?.clockIn ?? parsed.startAt.toISOString(),
        )} – ${formatTime(shift?.clockOut ?? parsed.endAt.toISOString())}.`,
        body: 'It is marked "added later" in your history. That is deliberate: a record that shows its own gaps is more credible than one that hides them.',
      })
    } catch (err) {
      setNotice({
        tone: 'bad',
        title: 'That did not save.',
        body: api.describeError(err),
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="retro-form" onSubmit={handleSubmit} noValidate>
      <div className="field">
        <label htmlFor="retro-date">Date you worked</label>
        <input
          id="retro-date"
          type="date"
          value={date}
          max={today}
          onChange={(e) => setDate(e.target.value)}
          required
        />
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="retro-start">Start time</label>
          <input
            id="retro-start"
            type="time"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="retro-end">End time</label>
          <input
            id="retro-end"
            type="time"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            required
          />
        </div>
      </div>

      {parsed.error ? (
        <p className="field-error" role="alert">
          {parsed.error}
        </p>
      ) : ready ? (
        <p className="field-preview">
          {formatDuration(durationMs)} on {formatDayLabel(parsed.startAt.toISOString())}
          {parsed.overnight ? ' — finishing the next morning' : ''}
        </p>
      ) : (
        <p className="field-preview dim">Fill in a date and both times.</p>
      )}

      <div className="button-row">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={!ready || saving}
        >
          {saving ? 'Saving…' : 'Add this shift'}
        </button>
        {onClose ? (
          <button
            type="button"
            className="btn"
            onClick={onClose}
            disabled={saving}
          >
            Done
          </button>
        ) : null}
      </div>

      {notice ? (
        <Notice
          tone={notice.tone}
          title={notice.title}
          onDismiss={() => setNotice(null)}
        >
          {notice.body}
        </Notice>
      ) : null}
    </form>
  )
}
