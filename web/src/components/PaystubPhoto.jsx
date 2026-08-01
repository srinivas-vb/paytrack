import { useId, useRef, useState } from 'react'
import { captureAndPrepare } from '../imageCapture.js'
import { postExtract, describeRefusal } from '../extractClient.js'
import './PaystubPhoto.css'

/**
 * Photograph a paystub instead of typing it.
 *
 * This component reads a paystub. It never records one. Whatever comes back
 * from `POST /api/extract` is handed upward through `onExtracted` to PRE-FILL
 * the existing manual form, where the worker checks every figure against the
 * paper in their hand and presses Save themselves.
 *
 * That is not a nicety. This record may end up in front of a labor
 * commissioner. A misread "7" that nobody was ever asked to confirm is worse
 * than no extraction at all, because it arrives wearing the same confidence as
 * a number the worker typed. So: extraction proposes, the worker disposes.
 *
 * Every failure route ends in the same place — the manual form — and none of
 * them is dressed up as a catastrophe. Typing five numbers is the ordinary way
 * to use this app, not a consolation prize.
 */

/** The five figures the form holds, in the order the form shows them. */
const FIELDS = [
  { key: 'periodStart', label: 'Pay period started', kind: 'date' },
  { key: 'periodEnd', label: 'Pay period ended', kind: 'date' },
  { key: 'paidHours', label: 'Hours paid for', kind: 'number' },
  { key: 'paidRate', label: 'Hourly rate', kind: 'money' },
  { key: 'grossPay', label: 'Gross pay', kind: 'money' },
]

/** Words a warning might use for each field, so warnings can be pinned to one. */
const FIELD_HINTS = {
  periodStart: ['period', 'start', 'dates', 'date'],
  periodEnd: ['period', 'end', 'dates', 'date'],
  paidHours: ['hour', 'hours'],
  paidRate: ['rate', 'hourly', 'wage'],
  grossPay: ['gross', 'pay', 'wages'],
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/* ---- transport ------------------------------------------------------ */

/* ---- shaping the response ------------------------------------------ */

function cleanDate(value) {
  return typeof value === 'string' && DATE_RE.test(value.trim())
    ? value.trim()
    : ''
}

function cleanNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.replace(/[$,\s]/g, ''))
    if (Number.isFinite(n)) return String(n)
  }
  return ''
}

/**
 * Turns the wire shape into the strings the manual form holds, discarding
 * anything malformed rather than passing a half-parsed value into a legal
 * record. A dropped field shows as "not read" and the worker types it.
 */
function toFormValues(fields) {
  const f = fields && typeof fields === 'object' ? fields : {}
  return {
    periodStart: cleanDate(f.periodStart),
    periodEnd: cleanDate(f.periodEnd),
    paidHours: cleanNumber(f.paidHours),
    paidRate: cleanNumber(f.paidRate),
    grossPay: cleanNumber(f.grossPay),
  }
}

/**
 * Which fields the worker should check hardest.
 *
 * The contract carries one confidence for the whole read plus free-text
 * `warnings[]`, so: anything short of "high" marks every value that came back,
 * and a warning that names a field marks that field specifically. Erring
 * towards marking too much is the correct direction of error here.
 */
function uncertainKeys({ confidence, warnings, values }) {
  const marked = new Set()
  const present = FIELDS.filter((f) => values[f.key] !== '')

  if (confidence !== 'high') {
    for (const f of present) marked.add(f.key)
  }

  for (const warning of warnings) {
    const text = String(warning).toLowerCase()
    for (const f of present) {
      if (FIELD_HINTS[f.key].some((word) => text.includes(word))) {
        marked.add(f.key)
      }
    }
  }
  return [...marked]
}

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return null
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/* ---- component ------------------------------------------------------ */

export default function PaystubPhoto({ onExtracted }) {
  const inputId = useId()
  const inputRef = useRef(null)

  const [image, setImage] = useState(null) // prepared image, or null
  const [busy, setBusy] = useState(null) // 'preparing' | 'reading' | null
  const [problem, setProblem] = useState(null) // a preparation problem
  const [outcome, setOutcome] = useState(null) // what the server said

  function reset() {
    setImage(null)
    setProblem(null)
    setOutcome(null)
    if (inputRef.current) inputRef.current.value = ''
  }

  async function handleFile(event) {
    const file = event.target.files?.[0]
    if (!file) return
    // Clear the input straight away, keeping the File we already hold. Without
    // this, retaking a photo that the browser considers the same file fires no
    // change event at all and the button silently does nothing.
    event.target.value = ''

    setBusy('preparing')
    setProblem(null)
    setOutcome(null)
    setImage(null)

    const prepared = await captureAndPrepare(file)
    setBusy(null)

    if (!prepared.ok) {
      // captureAndPrepare never throws, so this is always a sentence the
      // worker can act on rather than an exception we half-understand.
      setProblem(prepared.message)
      return
    }
    setImage(prepared)
  }

  async function handleRead() {
    if (!image || busy) return
    setBusy('reading')
    setOutcome(null)

    try {
      const result = await postExtract(image.dataUrl)

      const values = toFormValues(result?.fields)
      const warnings = Array.isArray(result?.warnings) ? result.warnings : []
      const confidence = result?.confidence ?? 'none'
      const anyValue = FIELDS.some((f) => values[f.key] !== '')

      // An honest empty read is still an empty read. Handing the form five
      // blanks and calling it success would be worse than saying so.
      if (!anyValue || confidence === 'none') {
        setOutcome({
          kind: 'manual',
          title: 'Nothing legible came back from that photo.',
          body: 'Type the figures into the form below instead. A typed paystub and a photographed one produce exactly the same record.',
          warnings,
        })
        return
      }

      const uncertain = uncertainKeys({ confidence, warnings, values })
      const payload = {
        fields: values,
        uncertainFields: uncertain,
        presentFields: Array.isArray(result?.presentFields)
          ? result.presentFields
          : undefined,
        confidence,
        warnings,
        source: result?.source ?? 'llm',
      }

      setOutcome({ kind: 'extracted', ...payload })
      onExtracted?.(payload)
    } catch (err) {
      setOutcome(describeRefusal(err))
    } finally {
      setBusy(null)
    }
  }

  const reading = busy === 'reading'

  return (
    <div className="photo">
      <p className="hint photo-intro">
        Take a photo of the paystub and PayTrack will try to read the figures
        off it. Whatever it reads goes into the form below for you to check —
        nothing is saved until you press Save yourself.
      </p>

      <div className="photo-pick">
        <label className="btn btn-wide photo-pick-label" htmlFor={inputId}>
          {image ? 'Choose a different photo' : 'Take or choose a photo'}
          <input
            id={inputId}
            ref={inputRef}
            className="photo-input"
            type="file"
            accept="image/*"
            capture="environment"
            onChange={handleFile}
            disabled={busy !== null}
          />
        </label>
      </div>

      {busy === 'preparing' ? (
        <p className="status loading" aria-live="polite">
          Preparing the photo…
        </p>
      ) : null}

      {problem ? (
        <p className="field-error" role="alert">
          {problem}
        </p>
      ) : null}

      {image ? (
        <div className="photo-preview">
          <img
            className="photo-thumb"
            src={image.dataUrl}
            alt="The paystub photo you chose, ready to be read"
          />
          <div className="photo-facts">
            <p className="photo-dims">
              {image.width} × {image.height} px
              {formatFileSize(image.bytes)
                ? ` · ${formatFileSize(image.bytes)}`
                : ''}
            </p>
            <p className="hint photo-privacy">
              Re-saved on your device at {image.width} px on the long edge. That
              rewrite drops the photo's hidden metadata, including the GPS tag
              your phone normally records, so it never leaves with the image.
            </p>
          </div>
        </div>
      ) : null}

      {image && outcome === null ? (
        <button
          type="button"
          className="btn btn-primary btn-wide"
          onClick={handleRead}
          disabled={busy !== null}
        >
          {reading ? 'Reading the paystub…' : 'Read this paystub'}
        </button>
      ) : null}

      {reading ? (
        <p className="status loading" aria-live="polite">
          Reading it now. This can take a few seconds.
        </p>
      ) : null}

      {outcome ? <Outcome outcome={outcome} onAgain={reset} /> : null}
    </div>
  )
}

/* ---- outcomes ------------------------------------------------------- */

function Outcome({ outcome, onAgain }) {
  if (outcome.kind === 'manual') {
    return (
      // Deliberately not `.status bad`. Manual entry is a first-class path, and
      // colouring this red would tell the worker they have hit a wall when they
      // have hit a fork in the road.
      <div className="photo-route" role="status">
        <p className="photo-route-title">{outcome.title}</p>
        <p className="photo-route-body">{outcome.body}</p>
        {outcome.warnings?.length ? (
          <ul className="photo-warnings">
            {outcome.warnings.map((w, i) => (
              <li key={i}>{String(w)}</li>
            ))}
          </ul>
        ) : null}
        <p className="notice-actions">
          <button type="button" className="btn btn-small" onClick={onAgain}>
            Try another photo
          </button>
        </p>
      </div>
    )
  }

  const uncertain = new Set(outcome.uncertainFields ?? [])

  return (
    <div className="photo-result" role="status">
      <p className="photo-route-title">
        Read from the photo. Now check every line.
      </p>
      <p className="photo-route-body">
        These have been put into the form below. Compare each one against the
        paystub in your hand and correct anything that is wrong before you save.
        PayTrack read a picture; it did not verify anything.
      </p>

      <dl className="photo-fields">
        {FIELDS.map((field) => {
          const value = outcome.fields[field.key]
          const flagged = uncertain.has(field.key)
          return (
            <div
              className={`photo-field${flagged ? ' photo-field-check' : ''}`}
              key={field.key}
            >
              <dt>{field.label}</dt>
              <dd>
                {value === '' ? (
                  <span className="photo-missing">not read — type it in</span>
                ) : (
                  <span className="photo-value">{value}</span>
                )}
                {flagged && value !== '' ? (
                  <span className="photo-flag">check this one</span>
                ) : null}
              </dd>
            </div>
          )
        })}
      </dl>

      {outcome.confidence !== 'high' ? (
        <p className="photo-confidence">
          The reader rated this whole page as low confidence, so every figure
          above is marked for checking.
        </p>
      ) : null}

      {outcome.warnings?.length ? (
        <div className="photo-warnings-block">
          <p className="photo-warnings-title">What the reader could not do:</p>
          <ul className="photo-warnings">
            {outcome.warnings.map((w, i) => (
              <li key={i}>{String(w)}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="notice-actions">
        <button type="button" className="btn btn-small" onClick={onAgain}>
          Start over with another photo
        </button>
      </p>
    </div>
  )
}
