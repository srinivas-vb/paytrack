import { useState } from 'react'
import * as api from '../api.js'
import { formatCalendarDate, formatHours, formatMoney } from '../format.js'
import AnalysisView from './AnalysisView.jsx'
import PaystubForm from './PaystubForm.jsx'
import { EmptyBlock, ErrorBlock, LoadingBlock, Notice } from './Ui.jsx'

/**
 * The Pay tab: enter what you were paid, then compare it against what you
 * recorded working.
 *
 * The paystub is the employer's claim; hours_log is the worker's. Neither is
 * treated as the truth — the product is the gap between them, shown with its
 * workings.
 */
export default function PayPanel({
  status,
  error,
  paystubs,
  onRetry,
  onChanged,
}) {
  const list = paystubs ?? []

  const [selectedId, setSelectedId] = useState(null)
  const [jurisdiction, setJurisdiction] = useState('california')
  const [confirmingId, setConfirmingId] = useState(null)
  const [removingId, setRemovingId] = useState(null)
  const [notice, setNotice] = useState(null)

  // The selection is DERIVED, not synced. Falling back to list[0] (newest pay
  // period, since the API sorts that way) means a deleted or not-yet-chosen
  // stub resolves without an effect writing state back on every render — and
  // there is no window where the analysis below points at a row that is gone.
  const selected = list.find((p) => p.id === selectedId) ?? list[0] ?? null

  async function handleDelete(id) {
    setRemovingId(id)
    setNotice(null)
    try {
      await api.deletePaystub(id)
      await onChanged()
      setConfirmingId(null)
      setNotice({
        tone: 'good',
        title: 'Paystub removed.',
        body: 'Your recorded hours are untouched — that log is append-only.',
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
        <h2>Your paystubs</h2>

        {status === 'loading' ? (
          <LoadingBlock>Loading your paystubs…</LoadingBlock>
        ) : null}

        {status === 'error' && list.length === 0 ? (
          <ErrorBlock
            error={error}
            onRetry={onRetry}
            title="Could not load your paystubs"
          />
        ) : null}

        {status !== 'loading' && status !== 'error' && list.length === 0 ? (
          <EmptyBlock title="No paystubs yet.">
            <p>
              Add one below with the numbers printed on it. PayTrack will work
              out what the hours you recorded were worth and show you both
              figures side by side — including when they agree.
            </p>
          </EmptyBlock>
        ) : null}

        {list.length > 0 ? (
          <ul className="stub-list">
            {list.map((stub) => (
              <li
                key={stub.id}
                className={`stub${stub.id === selected?.id ? ' stub-selected' : ''}`}
              >
                <label className="stub-choose">
                  <input
                    type="radio"
                    name="paystub"
                    checked={stub.id === selected?.id}
                    onChange={() => setSelectedId(stub.id)}
                  />
                  <span className="stub-main">
                    <span className="stub-period">
                      {formatCalendarDate(stub.periodStart)} –{' '}
                      {formatCalendarDate(stub.periodEnd)}
                    </span>
                    <span className="stub-figures">
                      {formatMoney(stub.grossPay)} gross ·{' '}
                      {formatHours(stub.paidHours)} at{' '}
                      {formatMoney(stub.paidRate)}/hr
                    </span>
                  </span>
                </label>

                {confirmingId === stub.id ? (
                  <div className="place-confirm">
                    <span className="hint">Remove it?</span>
                    <button
                      type="button"
                      className="btn btn-small btn-danger"
                      onClick={() => handleDelete(stub.id)}
                      disabled={removingId === stub.id}
                    >
                      {removingId === stub.id ? 'Removing…' : 'Remove'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-small"
                      onClick={() => setConfirmingId(null)}
                      disabled={removingId === stub.id}
                    >
                      Keep
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={() => setConfirmingId(stub.id)}
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : null}

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

      {selected ? (
        <AnalysisView
          paystubId={selected.id}
          jurisdiction={jurisdiction}
          onJurisdiction={setJurisdiction}
        />
      ) : null}

      <section className="card">
        <h2>Add a paystub</h2>
        <p className="hint">
          Copy the numbers exactly as they are printed. PayTrack never guesses a
          figure on your behalf — a number this app invented would be worth
          nothing to anyone reviewing your case.
        </p>
        <PaystubForm onCreated={onChanged} />
      </section>
    </>
  )
}
