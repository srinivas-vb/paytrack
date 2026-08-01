import { useMemo, useState } from 'react'
import * as api from '../api.js'
import { toDateInputValue } from '../format.js'
import { REQUIRED_ELEMENTS } from '../wageStatement.js'
import { Notice } from './Ui.jsx'

/**
 * Manual paystub entry: what the employer SAYS it paid.
 *
 * Everything here is a transcription of a document the worker is holding. The
 * form never guesses and never fills anything in on their behalf — a number
 * this app invented and then used to accuse an employer would be worthless.
 */
export default function PaystubForm({ onCreated }) {
  const today = useMemo(() => toDateInputValue(), [])

  const [periodStart, setPeriodStart] = useState('')
  const [periodEnd, setPeriodEnd] = useState('')
  const [paidHours, setPaidHours] = useState('')
  const [paidRate, setPaidRate] = useState('')
  const [grossPay, setGrossPay] = useState('')

  // Tri-state, mirroring the API. `checklistUsed === false` omits presentFields
  // entirely, so a worker who does not have the statement to hand is never
  // recorded as having nine missing elements.
  const [checklistUsed, setChecklistUsed] = useState(false)
  const [present, setPresent] = useState(() => new Set())

  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState(null)
  const [notice, setNotice] = useState(null)

  function toggleElement(key) {
    setPresent((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  /**
   * Client-side validation in plain language. The server validates again and is
   * the authority — this exists so the worker sees "Hours has to be a number"
   * instead of a round trip and a terse field name.
   */
  function validate() {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(periodStart)) {
      return 'Fill in the date the pay period started.'
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(periodEnd)) {
      return 'Fill in the date the pay period ended.'
    }
    if (periodEnd <= periodStart) {
      return 'The end date has to come after the start date.'
    }
    if (periodStart > today || periodEnd > today) {
      return 'A pay period cannot end in the future. Check the dates.'
    }

    const hours = Number(paidHours)
    if (paidHours.trim() === '' || !Number.isFinite(hours)) {
      return 'Enter the hours this paystub says you were paid for, as a number.'
    }
    if (hours < 0 || hours > 1000) {
      return 'Hours paid has to be between 0 and 1000.'
    }

    const rate = Number(paidRate)
    if (paidRate.trim() === '' || !Number.isFinite(rate)) {
      return 'Enter your hourly rate as a number.'
    }
    if (rate <= 0) {
      return 'Your hourly rate has to be more than 0.'
    }

    const gross = Number(grossPay)
    if (grossPay.trim() === '' || !Number.isFinite(gross)) {
      return 'Enter the gross pay as a number — the amount before deductions.'
    }
    if (gross < 0) {
      return 'Gross pay cannot be negative.'
    }

    return null
  }

  async function handleSubmit(event) {
    event.preventDefault()
    if (saving) return

    const problem = validate()
    if (problem) {
      setFormError(problem)
      setNotice(null)
      return
    }

    setSaving(true)
    setFormError(null)
    setNotice(null)
    try {
      await api.createPaystub({
        periodStart,
        periodEnd,
        paidHours: Number(paidHours),
        paidRate: Number(paidRate),
        grossPay: Number(grossPay),
        presentFields: checklistUsed
          ? REQUIRED_ELEMENTS.filter((e) => present.has(e.key)).map((e) => e.key)
          : undefined,
      })
      await onCreated()

      setPeriodStart('')
      setPeriodEnd('')
      setPaidHours('')
      setPaidRate('')
      setGrossPay('')
      setChecklistUsed(false)
      setPresent(new Set())
      setNotice({
        tone: 'good',
        title: 'Paystub saved.',
        body: 'Pick it in the list below to compare it against the hours you recorded.',
      })
    } catch (err) {
      setFormError(api.describeError(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      <div className="field-row">
        <div className="field">
          <label htmlFor="ps-start">Pay period started</label>
          <input
            id="ps-start"
            type="date"
            value={periodStart}
            max={today}
            onChange={(e) => setPeriodStart(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="ps-end">Pay period ended</label>
          <input
            id="ps-end"
            type="date"
            value={periodEnd}
            max={today}
            onChange={(e) => setPeriodEnd(e.target.value)}
            required
          />
        </div>
      </div>

      <div className="field">
        <label htmlFor="ps-hours">Hours it says you were paid for</label>
        <input
          id="ps-hours"
          type="text"
          inputMode="decimal"
          value={paidHours}
          placeholder="78"
          onChange={(e) => setPaidHours(e.target.value)}
          required
        />
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="ps-rate">Hourly rate</label>
          <input
            id="ps-rate"
            type="text"
            inputMode="decimal"
            value={paidRate}
            placeholder="20.00"
            onChange={(e) => setPaidRate(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="ps-gross">Gross pay</label>
          <input
            id="ps-gross"
            type="text"
            inputMode="decimal"
            value={grossPay}
            placeholder="1600.00"
            onChange={(e) => setGrossPay(e.target.value)}
            required
          />
        </div>
      </div>
      <p className="hint">
        Gross pay is the amount before tax and other deductions come out — not
        what landed in your account.
      </p>

      <label className="toggle">
        <input
          type="checkbox"
          checked={checklistUsed}
          onChange={(e) => setChecklistUsed(e.target.checked)}
        />
        <span>
          I have the pay statement in front of me
          <span className="toggle-hint">
            Turn this on to go through the nine things California law says every
            pay statement must show. Leave it off and nothing will be recorded
            as missing.
          </span>
        </span>
      </label>

      {checklistUsed ? (
        <fieldset className="checklist">
          <legend>Tick everything you can see on it</legend>
          <p className="hint">
            Leaving a box unticked records that it was not on the statement in
            front of you. That is not the same as proving your employer never
            issued it — the analysis says so too.
          </p>
          {REQUIRED_ELEMENTS.map((element) => (
            <label className="toggle" key={element.key}>
              <input
                type="checkbox"
                checked={present.has(element.key)}
                onChange={() => toggleElement(element.key)}
              />
              <span>
                {element.label}
                <span className="toggle-hint">{element.statute}</span>
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}

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
        {saving ? 'Saving…' : 'Save this paystub'}
      </button>

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
