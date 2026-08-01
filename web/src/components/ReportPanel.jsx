import { useCallback, useEffect, useRef, useState } from 'react'

import * as api from '../api.js'
import { useResource } from '../useResource.js'
import { getWorkerId } from '../workerId.js'
import { formatCalendarDate, formatHours, formatMoney } from '../format.js'
import { ErrorBlock, EmptyBlock, LoadingBlock, Notice } from './Ui.jsx'
import './Report.css'

/**
 * The evidence packet, and an honest account of what is going into it.
 *
 * Self-contained on purpose: it takes a `paystubId` and a `jurisdiction` and
 * fetches the four inputs itself, so it can be composed anywhere without the
 * host view having to hold shifts, verification and paystubs it does not
 * otherwise need. Anything the host DOES already hold can be passed in and is
 * preferred over the fetched copy, so the packet never lags the screen.
 *
 * The manifest above the button is not decoration. Someone about to hand a
 * document to a labor commissioner should be able to see, before they generate
 * it, how many entries it covers and whether the chain check passed — including
 * when the answer is "it didn't". A download button that reveals nothing until
 * after the file is on disk invites sending the wrong thing.
 */
export default function ReportPanel({
  paystubId = null,
  jurisdiction = 'california',
  analysis: analysisProp = null,
  shifts: shiftsProp = null,
  paystub: paystubProp = null,
  verification: verificationProp = null,
  workerId: workerIdProp = null,
  status: hostStatus = null,
}) {
  // Read at load time only. Render and build always prefer the live props
  // below, so a host that swaps one in mid-session is never served a stale copy.
  const provided = useRef({})
  provided.current = {
    analysis: analysisProp,
    shifts: shiftsProp,
    paystub: paystubProp,
    verification: verificationProp,
  }

  const load = useCallback(async () => {
    const have = provided.current
    const wanted = paystubId !== null && paystubId !== undefined

    const [analysis, shifts, paystub, verification] = await Promise.all([
      have.analysis ?? (wanted ? api.getAnalysis({ paystubId, jurisdiction }) : null),
      have.shifts ?? api.listShifts(200).then((r) => r.shifts),
      have.paystub ??
        (wanted
          ? api.listPaystubs().then((list) => list.find((p) => p.id === paystubId) ?? null)
          : null),
      have.verification ?? api.verifyChain(),
    ])

    return { analysis, shifts, paystub, verification }
  }, [paystubId, jurisdiction])

  const inputs = useResource(load)

  const analysis = analysisProp ?? inputs.data?.analysis ?? null
  const shifts = shiftsProp ?? inputs.data?.shifts ?? []
  const paystub = paystubProp ?? inputs.data?.paystub ?? null
  const verification = verificationProp ?? inputs.data?.verification ?? null
  const workerId = workerIdProp ?? safeWorkerId()

  const [building, setBuilding] = useState(false)
  const [notice, setNotice] = useState(null)
  const objectUrl = useRef(null)

  // A blob URL held past its download leaks the whole PDF in memory, and a
  // worker may generate this many times while getting the paystub right.
  useEffect(
    () => () => {
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current)
    },
    [],
  )

  async function handleDownload() {
    if (building) return
    setBuilding(true)
    setNotice(null)
    try {
      // jsPDF is ~400 kB and is needed only by the person who actually presses
      // this button. Loading it here rather than at the top of the module keeps
      // it out of the initial bundle — which matters, because the people this
      // is for are on phones and metered connections, and most visits to this
      // tab are to look at the figures rather than to file anything.
      const { buildEvidencePacket, evidencePacketFilename } = await import('../report.js')

      const blob = buildEvidencePacket({
        analysis,
        shifts,
        paystub,
        verification,
        workerId,
      })
      const name = evidencePacketFilename({ analysis, paystub })

      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current)
      objectUrl.current = URL.createObjectURL(blob)

      const link = document.createElement('a')
      link.href = objectUrl.current
      link.download = name
      document.body.appendChild(link)
      link.click()
      link.remove()

      setNotice({
        tone: 'good',
        title: 'Evidence packet saved.',
        body: `Saved as ${name}. Check it before you send it anywhere — every figure in it should match what you recorded.`,
      })
    } catch (err) {
      setNotice({
        tone: 'bad',
        title: 'Could not build the packet.',
        body: api.describeError(err),
      })
    } finally {
      setBuilding(false)
    }
  }

  const loading = hostStatus === 'loading' || (inputs.status === 'loading' && !analysis)
  const nothingSelected = paystubId === null || paystubId === undefined
  const failed = inputs.status === 'error' && !analysis

  return (
    <section className="card">
      <h2>Evidence packet</h2>

      <p className="hint">
        A PDF you can print, email, or hand to a lawyer or your state labor
        agency. It contains your own record of the hours you worked, the
        arithmetic behind every figure, and a plain statement of what this
        record cannot show.
      </p>

      {loading ? <LoadingBlock>Gathering your record…</LoadingBlock> : null}

      {!loading && nothingSelected && !analysis ? (
        <EmptyBlock title="Nothing to put in a packet yet.">
          <p>
            Add a paystub and pick it above. The packet compares one pay period
            at a time, so it needs to know which one.
          </p>
        </EmptyBlock>
      ) : null}

      {!loading && failed ? (
        <ErrorBlock
          error={inputs.error}
          onRetry={inputs.reload}
          title="Could not gather your record"
        />
      ) : null}

      {!loading && !failed && analysis ? (
        <>
          <Manifest
            analysis={analysis}
            shifts={shifts}
            paystub={paystub}
            verification={verification}
          />

          {inputs.status === 'error' ? (
            <p className="hint">
              The last refresh failed, so this may be out of date.{' '}
              <button type="button" className="btn-link" onClick={inputs.reload}>
                Refresh
              </button>
            </p>
          ) : null}

          <button
            type="button"
            className="btn btn-primary btn-wide"
            onClick={handleDownload}
            disabled={building}
          >
            {building ? 'Building the packet…' : 'Download evidence packet'}
          </button>

          <p className="hint report-note">
            Nothing is uploaded. The PDF is built on this device from the record
            already on screen.
          </p>
        </>
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

      <ul className="report-contents">
        <li>What this is, and that it is not legal advice</li>
        <li>The amount claimed, named to the jurisdiction it was worked out under</li>
        <li>Every workweek, with the hours in each bucket and the statute behind each one</li>
        <li>Every shift, with the server&rsquo;s own timestamp beside the time you claimed</li>
        <li>The record check: whether the chain of entries is unbroken</li>
        <li>Possible break premiums, kept out of the amount claimed</li>
        <li>What is excluded, and what this record cannot show</li>
      </ul>
    </section>
  )
}

/**
 * What is about to be in the file.
 *
 * The chain result is reported here whatever it says. A packet built on a
 * broken chain is still worth having — the break is itself a fact about the
 * record — but nobody should find that out from the PDF after sending it.
 */
function Manifest({ analysis, shifts, paystub, verification }) {
  const list = Array.isArray(shifts) ? shifts : []
  const completed = list.filter((s) => s.clockOut)
  const retro = list.filter((s) => s.isRetroactive)
  const weeks = Array.isArray(analysis?.workweeks) ? analysis.workweeks.length : 0
  const premiums = Array.isArray(analysis?.potentialPremiums)
    ? analysis.potentialPremiums.length
    : 0
  const discrepancy = Number(analysis?.discrepancy)
  const start = analysis?.periodStart ?? paystub?.periodStart
  const end = analysis?.periodEnd ?? paystub?.periodEnd

  const chain =
    verification === null
      ? { tone: 'unknown', text: 'not checked' }
      : verification.valid
        ? {
            tone: 'ok',
            text: `unbroken, ${verification.entryCount ?? 0} ${
              verification.entryCount === 1 ? 'entry' : 'entries'
            }`,
          }
        : { tone: 'broken', text: `broken at entry ${verification.brokenAt ?? 'unknown'}` }

  return (
    <div className="report-manifest">
      <p className="report-manifest-title">What this packet will contain</p>
      <dl className="report-facts">
        <div>
          <dt>Pay period</dt>
          <dd>
            {start ? formatCalendarDate(String(start).slice(0, 10)) : '—'} –{' '}
            {end ? formatCalendarDate(String(end).slice(0, 10)) : '—'}
          </dd>
        </div>
        <div>
          <dt>Rules applied</dt>
          <dd>{analysis?.jurisdiction === 'federal' ? 'Federal (FLSA)' : 'California'}</dd>
        </div>
        <div>
          <dt>Workweeks itemised</dt>
          <dd>{weeks}</dd>
        </div>
        <div>
          <dt>Shift entries listed</dt>
          <dd>
            {list.length}
            {retro.length > 0 ? `, ${retro.length} added later` : ''}
          </dd>
        </div>
        <div>
          <dt>Hours recorded</dt>
          <dd>{formatHours(sumHours(completed))}</dd>
        </div>
        <div>
          <dt>Difference stated</dt>
          <dd>{Number.isFinite(discrepancy) ? formatMoney(discrepancy) : '—'}</dd>
        </div>
        <div>
          <dt>Possible break premiums</dt>
          <dd>{premiums} (listed separately, not in the amount)</dd>
        </div>
        <div>
          <dt>Record check</dt>
          <dd className={`report-chain report-chain-${chain.tone}`}>{chain.text}</dd>
        </div>
      </dl>

      {verification && verification.valid === false ? (
        <p className="report-warn">
          The chain check did not pass. The packet will say so, in full, on its
          own page. That is deliberate — a record that hid a break would be
          worth less, not more.
        </p>
      ) : null}
    </div>
  )
}

function sumHours(shifts) {
  return shifts.reduce((total, s) => {
    const start = new Date(s.clockIn).getTime()
    const end = new Date(s.clockOut).getTime()
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return total
    return total + (end - start) / 3_600_000
  }, 0)
}

/** Storage can be blocked (private browsing); an id we cannot read is not fatal. */
function safeWorkerId() {
  try {
    return getWorkerId()
  } catch {
    return null
  }
}
