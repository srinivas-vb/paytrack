import { useEffect, useRef, useState } from 'react'
import * as api from '../api.js'
import { formatCalendarDate, formatHours, formatMoney } from '../format.js'
import AnalysisView from './AnalysisView.jsx'
import ExplainPanel from './ExplainPanel.jsx'
import PaystubForm from './PaystubForm.jsx'
import PaystubPhoto from './PaystubPhoto.jsx'
import ReportPanel from './ReportPanel.jsx'
import FilingPanel from './FilingPanel.jsx'
import { EmptyBlock, ErrorBlock, LoadingBlock, Notice } from './Ui.jsx'

/**
 * The Pay tab: enter what you were paid, then compare it against what you
 * recorded working.
 *
 * The paystub is the employer's claim; hours_log is the worker's. Neither is
 * treated as the truth — the product is the gap between them, shown with its
 * workings.
 */
const PAY_VIEWS = [
  { id: 'result', label: 'Your result' },
  { id: 'next', label: 'What to do next' },
]

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

  // Values read off a photo, waiting to be checked by a human. PaystubForm
  // seeds from these on mount only, so `extractedAt` is used as its key —
  // a second photo remounts the form with the new figures rather than
  // silently leaving the first read on screen.
  const [extracted, setExtracted] = useState(null)

  // Which half of the tab is showing: the result, or what to do about it.
  //
  // Stacked, these were 8,251px -- eleven screens, and roughly half of that was
  // reference material (where to file, what protects you, how long you have)
  // that a worker reads once, when they are ready to act, but had to scroll
  // past on every single visit to see their own figures.
  //
  // The split is by PURPOSE, not by length: everything in 'result' answers
  // "what am I owed", everything in 'next' answers "what do I do about it".
  const [view, setView] = useState('result')
  const viewsRef = useRef(null)

  // The selection is DERIVED, not synced. Falling back to list[0] (newest pay
  // period, since the API sorts that way) means a deleted or not-yet-chosen
  // stub resolves without an effect writing state back on every render — and
  // there is no window where the analysis below points at a row that is gone.
  const selected = list.find((p) => p.id === selectedId) ?? list[0] ?? null

  // Changing paystub returns you to the result. Landing on "what to do next"
  // for a pay period you have not looked at yet puts filing deadlines and
  // retaliation law in front of someone who does not yet know whether they
  // were underpaid at all.
  //
  // Keyed on the DERIVED id, not on `selectedId`. Deleting the shown stub
  // moves `selected` to a different pay period while `selectedId` is unchanged
  // or null, and that is exactly a case where the view must reset.
  const shownId = selected?.id ?? null
  useEffect(() => {
    setView('result')
  }, [shownId])

  // Switching brings the top of the panel into view. Without this you tap
  // "What to do next" while scrolled to the bottom of a long result and land
  // in the middle of retaliation law with no idea what you are looking at.
  //
  // `smooth` is not used: the whole point is that the destination is already
  // on screen by the time the finger lifts. Guarded on the ref because the
  // panel does not exist until a paystub is selected.
  function selectView(id) {
    setView(id)
    viewsRef.current?.scrollIntoView({ block: 'start' })
  }

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
        <div ref={viewsRef}>
          {/*
            Two halves of one question. Tab semantics rather than the
            `aria-pressed` pair the jurisdiction switch uses: that one filters
            what a figure means, this one swaps which panel you are reading,
            and a screen reader should be told which.
          */}
          <div className="segmented payviews" role="tablist" aria-label="Pay sections">
            {PAY_VIEWS.map((v) => (
              <button
                key={v.id}
                type="button"
                role="tab"
                id={`payview-${v.id}`}
                aria-selected={view === v.id}
                aria-controls={`paypanel-${v.id}`}
                className="segment"
                onClick={() => selectView(v.id)}
              >
                {v.label}
              </button>
            ))}
          </div>

          <div
            role="tabpanel"
            id={`paypanel-${view}`}
            aria-labelledby={`payview-${view}`}
            tabIndex={-1}
          >
            {view === 'result' ? (
              <>
                <AnalysisView
                  paystubId={selected.id}
                  jurisdiction={jurisdiction}
                  onJurisdiction={setJurisdiction}
                />

                {/* Directly under the figures it describes, and nowhere else.
                    The explanation is a paraphrase of the analysis above, so it
                    has to be read after it — and it is optional, so everything
                    below here works identically when it is switched off. */}
                <ExplainPanel paystubId={selected.id} jurisdiction={jurisdiction} />

                {/* The packet is what a worker actually hands to someone. It
                    stays with the figures it is built from, so what is on
                    screen and what is in the file are visibly the same. */}
                <ReportPanel paystubId={selected.id} jurisdiction={jurisdiction} />
              </>
            ) : (
              /* A PDF alone leaves the worker stuck. Fear of retaliation, not
                 lack of evidence, is the main reason people do not file — so
                 the filing route and the protection stay together here, one
                 tap from the result rather than four screens below it. */
              <FilingPanel
                jurisdiction={jurisdiction}
                periodStart={selected.periodStart}
                periodEnd={selected.periodEnd}
              />
            )}
          </div>
        </div>
      ) : null}

      {/* Outside the two views on purpose. Adding a paystub is not a step in
          reading your result and it is not a next step either — it is how you
          get more of both, so it stays reachable from either view. Closed by
          default: it is 700px of form that most visits do not need. */}
      <details className="card addstub">
        <summary className="addstub-summary">
          <h2>Add a paystub</h2>
        </summary>
        <p className="hint">
          Copy the numbers exactly as they are printed. PayTrack never guesses a
          figure on your behalf — a number this app invented would be worth
          nothing to anyone reviewing your case.
        </p>

        {/* Photo first, form below. On a build with no reader configured this
            says so and points at the form, which is why the form is always
            rendered rather than hidden behind the photo path. */}
        <PaystubPhoto onExtracted={(payload) => setExtracted({ ...payload, at: Date.now() })} />

        <PaystubForm
          key={extracted?.at ?? 'blank'}
          initialValues={extracted?.fields ?? null}
          uncertainFields={extracted?.uncertainFields ?? null}
          onCreated={() => {
            setExtracted(null)
            onChanged()
          }}
        />
      </details>
    </>
  )
}
