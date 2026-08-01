import { useCallback } from 'react'
import * as api from '../api.js'
import { ApiError } from '../api.js'
import { useResource } from '../useResource.js'
import {
  formatHours,
  formatMoney,
  formatMultiplier,
  formatWeekRange,
} from '../format.js'
import { describeElement } from '../wageStatement.js'
import { ErrorBlock, LoadingBlock } from './Ui.jsx'

const JURISDICTIONS = [
  { id: 'federal', label: 'Federal' },
  { id: 'california', label: 'California' },
]

/**
 * The verdict for one paystub.
 *
 * Four things on this screen are product decisions rather than layout choices,
 * and each one is a place a wage app could quietly start lying:
 *
 *   1. A zero or negative difference renders in exactly the same block, at
 *      exactly the same size, as a positive one. Only the sentence changes.
 *      An app that dresses "nothing is owed" as an empty state or a failure is
 *      an accusation generator, not evidence.
 *   2. Possible break premiums sit OUTSIDE the amount, in their own block,
 *      with the reason PayTrack cannot know. They are never added up into
 *      anything that looks like a total.
 *   3. Missing wage-statement elements say what they actually mean: absent
 *      from the form the worker filled in, which is not proof of absent from
 *      the employer's original statement.
 *   4. The scope exclusions are on screen, not buried in a doc, because if any
 *      of them apply then every figure here is too LOW — and that is the
 *      question a judge or a labor commissioner will ask first.
 */
export default function AnalysisView({ paystubId, jurisdiction, onJurisdiction }) {
  const load = useCallback(
    () => api.getAnalysis({ paystubId, jurisdiction }),
    [paystubId, jurisdiction],
  )
  const analysis = useResource(load)

  // A 404 covers both "no such paystub" and "the rule engine isn't wired up
  // yet". Neither is a crash, and neither should look like one.
  const notBuiltYet =
    analysis.status === 'error' &&
    analysis.error instanceof ApiError &&
    analysis.error.status === 404

  return (
    <section className="card">
      <h2>What your hours were worth</h2>

      <div className="segmented" role="group" aria-label="Which law to apply">
        {JURISDICTIONS.map((j) => (
          <button
            key={j.id}
            type="button"
            className="segment"
            aria-pressed={jurisdiction === j.id}
            onClick={() => onJurisdiction(j.id)}
          >
            {j.label}
          </button>
        ))}
      </div>
      <p className="hint">
        The same hours are worth different amounts under different rules.
        California adds daily overtime and a 7th-day rule; federal law only
        counts hours past 40 in a week.
      </p>

      {analysis.status === 'loading' ? (
        <LoadingBlock>Working out what you were owed…</LoadingBlock>
      ) : null}

      {notBuiltYet ? (
        <div className="status warn" role="status">
          <strong>This comparison is not available yet.</strong>
          <p>
            Your paystub is saved and your hours are safe. The part that
            compares them is still being built.
          </p>
          <p className="notice-actions">
            <button
              type="button"
              className="btn btn-small"
              onClick={analysis.reload}
            >
              Try again
            </button>
          </p>
        </div>
      ) : null}

      {analysis.status === 'error' && !notBuiltYet ? (
        <ErrorBlock
          error={analysis.error}
          onRetry={analysis.reload}
          title="Could not work this out"
        />
      ) : null}

      {analysis.data ? <AnalysisBody data={analysis.data} /> : null}
    </section>
  )
}

function AnalysisBody({ data }) {
  const workweeks = Array.isArray(data.workweeks) ? data.workweeks : []
  const premiums = Array.isArray(data.potentialPremiums)
    ? data.potentialPremiums
    : []
  const flags = Array.isArray(data.complianceFlags) ? data.complianceFlags : []
  const exclusions = Array.isArray(data.scopeExclusions)
    ? data.scopeExclusions
    : ['tips', 'commissions', 'nondiscretionary bonuses']

  return (
    <>
      <Difference
        discrepancy={data.discrepancy}
        totalOwed={data.totalOwed}
        totalPaid={data.totalPaid}
      />

      <h3 className="section-head">Week by week</h3>
      <p className="hint">
        Overtime is worked out one week at a time and never averaged across
        weeks. A fortnight of 45 hours then 35 hours is 5 hours of overtime,
        not none.
      </p>

      {workweeks.length === 0 ? (
        <p className="hint">
          There are no hours on record inside this pay period. Add the shifts
          you worked on the History tab and this will fill in.
        </p>
      ) : (
        <ul className="week-list">
          {workweeks.map((week, i) => (
            <Workweek key={week.start ?? i} week={week} />
          ))}
        </ul>
      )}

      <PotentialPremiums premiums={premiums} />
      <ComplianceFlags flags={flags} />
      <ScopeExclusions exclusions={exclusions} rate={data.hourlyRate} />
    </>
  )
}

/**
 * The headline number.
 *
 * One block, one size, one colour, whatever the sign. See the note at the top
 * of this file: this is the requirement, not the styling.
 */
function Difference({ discrepancy, totalOwed, totalPaid }) {
  const known = Number.isFinite(discrepancy)

  let sentence
  if (!known) {
    sentence = 'The difference could not be worked out from what is on record.'
  } else if (discrepancy > 0) {
    sentence = 'The hours you recorded are worth more than this paystub paid.'
  } else if (discrepancy === 0) {
    sentence =
      'The hours you recorded and this paystub agree. Nothing is owed for this pay period.'
  } else {
    sentence =
      'This paystub paid more than the hours you recorded are worth. Nothing is owed for this pay period.'
  }

  return (
    <div className="finding">
      <p className="finding-label">Difference for this pay period</p>
      <p className="finding-amount">{known ? formatMoney(discrepancy) : '—'}</p>
      <p className="finding-sentence">{sentence}</p>

      <dl className="finding-totals">
        <div>
          <dt>Your recorded hours are worth</dt>
          <dd>{formatMoney(totalOwed)}</dd>
        </div>
        <div>
          <dt>This paystub paid</dt>
          <dd>{formatMoney(totalPaid)}</dd>
        </div>
      </dl>

      <p className="hint">
        This is an estimate built from the hours you recorded. It is not legal
        advice and not a decision by any court or agency.
      </p>
    </div>
  )
}

function Workweek({ week }) {
  const breakdown = week.breakdown ?? {}
  const straight = Number(breakdown.straightHours) || 0
  const overtime = Number(breakdown.overtimeHours) || 0
  const doubleTime = Number(breakdown.doubleTimeHours) || 0
  const reasons = Array.isArray(breakdown.reasons) ? breakdown.reasons : []

  const bucketSum = straight + overtime + doubleTime
  const total = Number(week.totalHours)
  // Every hour must land in exactly one bucket (contracts.md rule 3). If they
  // ever disagree, say so on screen rather than presenting a total that does
  // not add up.
  const balances = !Number.isFinite(total) || Math.abs(bucketSum - total) < 0.005

  return (
    <li className="week">
      <div className="week-head">
        <span className="week-range">
          {formatWeekRange(week.start, week.end)}
        </span>
        <span className="week-total">{formatHours(total)}</span>
      </div>

      <ul className="buckets">
        <li>
          <span>Regular pay (1×)</span>
          <span>{formatHours(straight)}</span>
        </li>
        <li>
          <span>Overtime (1.5×)</span>
          <span>{formatHours(overtime)}</span>
        </li>
        <li>
          <span>Double time (2×)</span>
          <span>{formatHours(doubleTime)}</span>
        </li>
      </ul>

      {balances ? (
        <p className="week-check">
          Every hour counted once — the three add up to {formatHours(bucketSum)}.
        </p>
      ) : (
        <p className="field-error" role="alert">
          These buckets add up to {formatHours(bucketSum)} but the week totals{' '}
          {formatHours(total)}. Do not rely on this week&apos;s figure.
        </p>
      )}

      {reasons.length > 0 ? (
        <ul className="reasons">
          {reasons.map((reason, i) => (
            <li key={`${reason.basis ?? 'reason'}-${i}`}>
              <span className="reason-hours">
                {formatHours(Number(reason.hours))} at{' '}
                {formatMultiplier(Number(reason.multiplier))}
              </span>
              <span className="reason-basis">{reason.basis}</span>
              {reason.statute ? (
                <span className="reason-statute">{reason.statute}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="hint">No overtime in this week.</p>
      )}

      <p className="week-owed">
        This week&apos;s hours are worth {formatMoney(Number(week.owed))}.
      </p>
    </li>
  )
}

/**
 * Meal and rest premiums — deliberately outside every total on this screen.
 *
 * PayTrack sees a clock-in and a clock-out. It cannot see whether a break was
 * taken, so a long unbroken entry is equally consistent with a missed break and
 * with a break nobody logged. Presenting these as owed would inflate the number
 * a worker walks into a labor commissioner's office with, and an inflated
 * number makes a worse case than a conservative one.
 */
function PotentialPremiums({ premiums }) {
  return (
    <section className="aside">
      <h3>Possible break premiums — not included in the amount above</h3>
      <p>
        PayTrack sees when you clocked in and out. It cannot see whether you
        actually took a break. These are flags to check, not money you are owed,
        and they are kept out of every total on this page on purpose.
      </p>

      {premiums.length === 0 ? (
        <p className="hint">
          Nothing flagged in this pay period. That does not prove your breaks
          were given — only that nothing in the recorded hours pointed at a
          problem.
        </p>
      ) : (
        <ul className="premium-list">
          {premiums.map((premium, i) => (
            <li key={`${premium.workday ?? 'day'}-${premium.type ?? i}`}>
              <div className="premium-head">
                <span className="premium-type">
                  {premium.type === 'meal'
                    ? 'Possible missed meal break'
                    : premium.type === 'rest'
                      ? 'Possible missed rest break'
                      : 'Possible missed break'}
                </span>
                <span className="premium-amount">
                  {formatMoney(Number(premium.amount))} if it applies
                </span>
              </div>
              {premium.workday ? (
                <p className="premium-day">{premium.workday}</p>
              ) : null}
              {premium.explanation ? <p>{premium.explanation}</p> : null}
              {premium.statute ? (
                <p className="reason-statute">{premium.statute}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * § 226(a) elements absent from what the worker entered.
 *
 * The caveat is not a disclaimer bolted on afterwards — it is the honest
 * meaning of the data. This app knows what was ticked on a form, and nothing
 * whatsoever about the paper the employer issued.
 */
function ComplianceFlags({ flags }) {
  return (
    <section className="aside">
      <h3>What your pay statement has to show</h3>
      <p>
        California law lists nine things every pay statement must include. A
        missing one is its own separate violation, apart from any unpaid wages.
      </p>
      <p className="caveat">
        These flags describe the form you filled in — <strong>not</strong> your
        employer&apos;s original statement. If one of these actually was printed
        on it, that is not a violation; add the paystub again with the box
        ticked.
      </p>

      {flags.length === 0 ? (
        <p className="hint">
          Nothing flagged. Either everything was ticked, or you have not gone
          through the checklist for this paystub yet.
        </p>
      ) : (
        <ul className="flag-list">
          {flags.map((flag, i) => {
            const element = describeElement(flag.element)
            return (
              <li key={flag.element ?? i}>
                <span className="flag-label">{element.label}</span>
                <span className="reason-statute">
                  {flag.statute ?? element.statute}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

/**
 * The scope cut, stated on screen.
 *
 * Every one of these raises the regular rate (29 C.F.R. § 778). If any of them
 * apply to this worker, every figure above is too LOW — which is the direction
 * that protects them, and exactly the question a wage lawyer asks first.
 */
function ScopeExclusions({ exclusions, rate }) {
  return (
    <section className="aside">
      <h3>What is not counted here</h3>
      <ul className="exclusion-list">
        {exclusions.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <p>
        These figures treat your regular rate as exactly your hourly rate
        {Number.isFinite(Number(rate)) ? ` (${formatMoney(Number(rate))} an hour)` : ''}.
        If you also get any of the above, your real regular rate is higher and
        every number on this page is too low, not too high.
      </p>
      <p className="hint">
        This tool also assumes one employer and hourly, non-exempt work.
      </p>
    </section>
  )
}
