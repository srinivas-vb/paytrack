import { useState } from 'react'
import * as api from '../api.js'
import { geolocationSupported, requestPosition } from '../geo.js'
import { formatDateTime } from '../format.js'
import { EmptyBlock, ErrorBlock, LoadingBlock, Notice } from './Ui.jsx'

const clamp = (value, min, max) =>
  Number.isFinite(value) && value >= min && value <= max

export default function WorkplacesPanel({
  status,
  error,
  workplaces,
  onRetry,
  onChanged,
}) {
  const [label, setLabel] = useState('')
  const [lat, setLat] = useState('')
  const [lng, setLng] = useState('')
  const [locating, setLocating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState(null)
  const [formError, setFormError] = useState(null)
  const [confirmingId, setConfirmingId] = useState(null)
  const [removingId, setRemovingId] = useState(null)

  const list = workplaces ?? []

  async function useCurrentLocation() {
    setLocating(true)
    setFormError(null)
    const fix = await requestPosition()
    setLocating(false)

    if (!fix.ok) {
      // Manual entry stays on screen precisely so this is a detour, not a wall.
      setFormError(`${fix.message} You can type the coordinates in below.`)
      return
    }
    setLat(fix.lat.toFixed(6))
    setLng(fix.lng.toFixed(6))
    setNotice({
      tone: 'good',
      title: 'Location filled in.',
      body: fix.accuracyM
        ? `Accurate to about ${fix.accuracyM} m — good enough; the match radius is generous.`
        : null,
    })
  }

  async function handleSubmit(event) {
    event.preventDefault()
    if (saving) return

    const trimmed = label.trim()
    const latNum = Number(lat)
    const lngNum = Number(lng)

    if (trimmed.length < 1 || trimmed.length > 100) {
      setFormError('Give the place a name, up to 100 characters.')
      return
    }
    if (lat === '' || lng === '' || !clamp(latNum, -90, 90) || !clamp(lngNum, -180, 180)) {
      setFormError(
        'Latitude must be between −90 and 90, longitude between −180 and 180.',
      )
      return
    }

    setSaving(true)
    setFormError(null)
    setNotice(null)
    try {
      await api.createWorkplace({ label: trimmed, lat: latNum, lng: lngNum })
      await onChanged()
      setLabel('')
      setLat('')
      setLng('')
      setNotice({ tone: 'good', title: `Saved “${trimmed}”.` })
    } catch (err) {
      setFormError(api.describeError(err))
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id) {
    setRemovingId(id)
    setNotice(null)
    try {
      await api.deleteWorkplace(id)
      await onChanged()
      setConfirmingId(null)
      setNotice({
        tone: 'good',
        title: 'Workplace removed.',
        body: 'Your past shifts are untouched — the log is append-only.',
      })
    } catch (err) {
      setNotice({
        tone: 'bad',
        title: 'Could not remove it.',
        body: api.describeError(err),
      })
    } finally {
      setRemovingId(null)
    }
  }

  return (
    <>
      <section className="card">
        <h2>Your workplaces</h2>

        {status === 'loading' ? (
          <LoadingBlock>Loading your workplaces…</LoadingBlock>
        ) : null}

        {status === 'error' && list.length === 0 ? (
          <ErrorBlock
            error={error}
            onRetry={onRetry}
            title="Could not load your workplaces"
          />
        ) : null}

        {status !== 'loading' && status !== 'error' && list.length === 0 ? (
          <EmptyBlock title="No workplaces saved.">
            <p>
              Saving a workplace lets PayTrack note whether a shift was logged
              near your usual site. It is optional — clocking in works fine
              without one.
            </p>
          </EmptyBlock>
        ) : null}

        {list.length > 0 ? (
          <ul className="place-list">
            {list.map((place) => (
              <li key={place.id} className="place">
                <div className="place-main">
                  <span className="place-label">{place.label}</span>
                  <span className="place-coords">
                    {Number(place.lat).toFixed(5)},{' '}
                    {Number(place.lng).toFixed(5)}
                  </span>
                  {place.createdAt ? (
                    <span className="place-coords dim">
                      Added {formatDateTime(place.createdAt)}
                    </span>
                  ) : null}
                </div>

                {confirmingId === place.id ? (
                  <div className="place-confirm">
                    <span className="hint">Remove it?</span>
                    <button
                      type="button"
                      className="btn btn-small btn-danger"
                      onClick={() => handleDelete(place.id)}
                      disabled={removingId === place.id}
                    >
                      {removingId === place.id ? 'Removing…' : 'Remove'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-small"
                      onClick={() => setConfirmingId(null)}
                      disabled={removingId === place.id}
                    >
                      Keep
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={() => setConfirmingId(place.id)}
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="card">
        <h2>Add a workplace</h2>
        <form onSubmit={handleSubmit} noValidate>
          <div className="field">
            <label htmlFor="wp-label">Name</label>
            <input
              id="wp-label"
              type="text"
              value={label}
              maxLength={100}
              placeholder="Main warehouse"
              onChange={(e) => setLabel(e.target.value)}
              required
            />
          </div>

          <button
            type="button"
            className="btn btn-wide"
            onClick={useCurrentLocation}
            disabled={locating || saving || !geolocationSupported()}
          >
            {locating ? 'Finding you…' : 'Use my current location'}
          </button>
          {!geolocationSupported() ? (
            <p className="hint">
              This browser cannot share a location — type the coordinates
              instead.
            </p>
          ) : null}

          <div className="field-row">
            <div className="field">
              <label htmlFor="wp-lat">Latitude</label>
              <input
                id="wp-lat"
                type="text"
                inputMode="decimal"
                value={lat}
                placeholder="37.774900"
                onChange={(e) => setLat(e.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="wp-lng">Longitude</label>
              <input
                id="wp-lng"
                type="text"
                inputMode="decimal"
                value={lng}
                placeholder="-122.419400"
                onChange={(e) => setLng(e.target.value)}
                required
              />
            </div>
          </div>

          {formError ? (
            <p className="field-error" role="alert">
              {formError}
            </p>
          ) : null}

          <button
            type="submit"
            className="btn btn-primary btn-wide"
            disabled={saving}
          >
            {saving ? 'Saving…' : 'Save workplace'}
          </button>
        </form>

        {notice ? (
          <Notice
            tone={notice.tone}
            title={notice.title}
            onDismiss={() => setNotice(null)}
          >
            {notice.body}
          </Notice>
        ) : null}
      </section>
    </>
  )
}
