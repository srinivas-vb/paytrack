import './Filing.css'
import { formatCalendarDate } from '../format.js'
import {
  getFilingInfo,
  getFilingWindows,
  soonestWindow,
} from '../jurisdictions.js'

/**
 * What to do with the record — and what protects you while you do it.
 *
 * A worker holding a PDF that proves they are owed money is still stuck if
 * they do not know where to take it. And the reason most of them never take it
 * anywhere is not that the evidence is thin. It is that they are afraid of what
 * happens to them at work the next morning.
 *
 * So this panel is built around three commitments:
 *
 *   1. **Retaliation gets equal weight, not a footnote.** It is its own card,
 *      with the same `.filing-lead` heading treatment as the filing steps, and
 *      it sits directly after them rather than at the bottom. Retaliation is
 *      separately illegal and separately worth money, and that is stated in the
 *      first sentence, not buried in the fifth.
 *   2. **Deadlines are a date, not a duration.** "3 years" asks a frightened
 *      person to do date arithmetic. "Until roughly July 2029" does not. The
 *      window is counted from the START of the pay period, which is the
 *      earliest violation in it and therefore the first to expire.
 *   3. **Plain language, phone-sized.** Short sentences. Every statute gets a
 *      plain-English gloss before the citation. Every link is a 48px target.
 *
 * Props — all optional, and the panel degrades to the general rules rather
 * than to an error if a pay period is missing:
 *
 *   jurisdiction  'california' | 'federal'  (defaults to federal — FLSA is the floor)
 *   periodStart   paystub.periodStart, 'YYYY-MM-DD'
 *   periodEnd     paystub.periodEnd,   'YYYY-MM-DD'
 *   now           injectable clock, for tests
 */
export default function FilingPanel({
  jurisdiction = 'federal',
  periodStart = null,
  periodEnd = null,
  now,
}) {
  const info = getFilingInfo(jurisdiction)
  const windows = getFilingWindows(info, { periodStart, periodEnd, now })
  const soonest = soonestWindow(windows)

  const [primary, ...alternates] = info.routes

  return (
    <>
      <FilingSteps primary={primary} alternates={alternates} />
      <Retaliation info={info} />
      <Deadlines windows={windows} soonest={soonest} info={info} />
      <GetHelp info={info} primary={primary} />
    </>
  )
}

/* ---- filing -------------------------------------------------------- */

function FilingSteps({ primary, alternates }) {
  return (
    <section className="card">
      <h2>Where to take this</h2>

      <p className="filing-lead">
        You can file a wage claim yourself. It is free, and you do not need a
        lawyer to do it.
      </p>

      <Route route={primary} />

      {alternates.map((route) => (
        <details className="filing-alt" key={route.id}>
          <summary>Or file with {route.shortName} instead</summary>
          <p className="hint">
            You can file with either. They are separate agencies applying
            different laws, and the amounts can come out differently — the
            comparison above shows you by how much.
          </p>
          <Route route={route} compact />
        </details>
      ))}
    </section>
  )
}

function Route({ route, compact = false }) {
  return (
    <div className="filing-route">
      <p className="filing-agency">{route.agency}</p>
      <p className="filing-what">{route.what}</p>

      <p className="filing-cost">{route.cost}</p>

      <div className="filing-links">
        <a
          className="btn btn-primary filing-link"
          href={route.url}
          target="_blank"
          rel="noreferrer noopener"
        >
          How to file
        </a>
        {route.formUrl ? (
          <a
            className="btn filing-link"
            href={route.formUrl}
            target="_blank"
            rel="noreferrer noopener"
          >
            Get the form (PDF)
          </a>
        ) : null}
        <a className="btn filing-link" href={`tel:${route.phone.replace(/[^\d+]/g, '')}`}>
          Call {route.phone}
        </a>
      </div>

      <p className="filing-form-name">
        The form is called: <strong>{route.formName}</strong>
      </p>

      {compact ? null : (
        <>
          <h3 className="filing-head">What happens, step by step</h3>
          <ol className="filing-steps">
            {route.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </>
      )}

      <h3 className="filing-head">What to have with you</h3>
      <ul className="filing-bring">
        {route.bring.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>

      {route.extras.length > 0 ? (
        <ul className="filing-extras">
          {route.extras.map((extra) => (
            <li key={extra.name}>
              <a href={extra.url} target="_blank" rel="noreferrer noopener">
                {extra.name}
              </a>
              <span className="filing-extra-why">{extra.why}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <p className="hint">{route.languages}</p>
    </div>
  )
}

/* ---- retaliation --------------------------------------------------- */

/**
 * Deliberately the same shape and weight as the filing card above it.
 *
 * If this were a warning strip at the bottom of the page it would read as a
 * disclaimer, and a worker who is already scared would take it as confirmation
 * that filing is risky. It is the opposite: this is the part that tells them
 * the law already anticipated their employer doing exactly this, and attached
 * money to it.
 */
function Retaliation({ info }) {
  const route = info.retaliationRoute

  return (
    <section className="card filing-shield">
      <h2>If your employer punishes you for this</h2>

      <p className="filing-lead">
        Punishing you for asking about your pay is itself against the law. It is
        a second case, separate from the money you are owed — and it is worth
        money of its own.
      </p>

      <p>
        Getting fired is the obvious one. So are cutting your hours, moving you
        to worse shifts, demoting you, threatening you, or suddenly writing you
        up for things nobody minded before.
      </p>

      {info.antiRetaliation.map((law) => (
        <div className="filing-law" key={law.statute}>
          <p className="filing-law-scope">{law.scope}</p>
          <p className="filing-law-summary">{law.summary}</p>
          <ul className="filing-remedies">
            {law.remedies.map((remedy) => (
              <li key={remedy}>{remedy}</li>
            ))}
          </ul>
          <p className="filing-statute">{law.statute}</p>

          {(law.highlights ?? []).map((highlight) => (
            <div className="filing-highlight" key={highlight.label}>
              <p className="filing-highlight-label">{highlight.label}</p>
              <p>{highlight.body}</p>
              {highlight.why ? <p className="hint">{highlight.why}</p> : null}
            </div>
          ))}
        </div>
      ))}

      <h3 className="filing-head">If it happens, do this first</h3>
      <p>
        Write it down the same day. A timeline written while you remember it is
        worth far more than one reconstructed months later — and dates are what
        the 90-day rule turns on.
      </p>
      <ol className="filing-steps">
        {info.documentSteps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>

      <h3 className="filing-head">Then file a retaliation complaint</h3>
      <div className="filing-route">
        <p className="filing-agency">{route.agency}</p>
        <p className="filing-form-name">
          The form is called: <strong>{route.formName}</strong>
        </p>
        <p className="filing-deadline-line">
          <strong>Deadline:</strong> {route.deadline}{' '}
          <span className="filing-statute-inline">{route.deadlineStatute}</span>
        </p>
        <p className="filing-what">{route.note}</p>
        <div className="filing-links">
          <a
            className="btn btn-primary filing-link"
            href={route.url}
            target="_blank"
            rel="noreferrer noopener"
          >
            How to file this
          </a>
          {route.formUrl ? (
            <a
              className="btn filing-link"
              href={route.formUrl}
              target="_blank"
              rel="noreferrer noopener"
            >
              Get the form (PDF)
            </a>
          ) : null}
        </div>
      </div>

      <Immigration immigration={info.immigration} />
    </section>
  )
}

/**
 * The single fact most often missing from the people who need it most.
 *
 * Kept inside the retaliation card on purpose. The threat and the answer to
 * the threat belong on the same screen.
 */
function Immigration({ immigration }) {
  return (
    <div className="filing-immigration">
      <h3 className="filing-head">{immigration.title}</h3>
      <ul className="filing-bring">
        {immigration.points.map((point) => (
          <li key={point}>{point}</li>
        ))}
      </ul>
      {immigration.federalNote ? (
        <p className="hint">{immigration.federalNote}</p>
      ) : null}
    </div>
  )
}

/* ---- deadlines ----------------------------------------------------- */

function Deadlines({ windows, soonest, info }) {
  const anyKnown = windows.some((w) => w.known)

  return (
    <section className="card">
      <h2>How long you have</h2>

      <p className="filing-lead">
        {soonest
          ? `On this pay period, the first deadline runs out around ${soonest.dueMonthLabel}.`
          : anyKnown
            ? 'On this pay period, the deadlines below have already run out.'
            : 'Add a paystub with its pay period dates and these turn into real dates.'}
      </p>

      <p className="filing-warning">
        Deadlines are strict. If one passes, that claim can be over — however
        good the record is. File well before the date, not on it.
      </p>

      <ul className="filing-deadlines">
        {windows.map((w) => (
          <Deadline key={w.id} window={w} />
        ))}
      </ul>

      {anyKnown ? (
        <p className="hint">
          These dates are approximate. They are counted from the{' '}
          <strong>start</strong> of the pay period
          {windows[0]?.anchorIso
            ? ` (${formatCalendarDate(windows[0].anchorIso)})`
            : ''}
          , because the clock runs from when each violation happened — so the
          earliest day in the period is the first to expire. Treat them as
          &ldquo;by then at the very latest&rdquo;, and confirm the real date
          with the agency or a lawyer.
        </p>
      ) : null}

      <p className="hint">{info.otherClaimsNote}</p>
    </section>
  )
}

function Deadline({ window: w }) {
  return (
    <li className="filing-deadline">
      <p className="filing-deadline-claim">{w.claim}</p>

      {w.known ? (
        <>
          <p
            className={`filing-deadline-date${w.expired ? ' expired' : ''}${w.urgent ? ' urgent' : ''}`}
          >
            {w.expired
              ? `Ran out around ${w.dueMonthLabel}`
              : `Until roughly ${w.dueMonthLabel}`}
          </p>
          <p className="filing-deadline-left">
            {w.expired
              ? 'File anyway and ask. Deadlines have exceptions, later pay periods may still be in time, and only the agency or a lawyer can tell you which apply.'
              : w.monthsLeft <= 0
                ? 'Less than a month left. Call the agency today.'
                : `About ${w.monthsLeft} month${w.monthsLeft === 1 ? '' : 's'} left — ${w.years} year${w.years === 1 ? '' : 's'} from the start of this pay period.`}
          </p>
        </>
      ) : (
        <p className="filing-deadline-date">
          {w.years} year{w.years === 1 ? '' : 's'} from when each violation
          happened
        </p>
      )}

      {w.note ? <p className="filing-deadline-note">{w.note}</p> : null}
      <p className="filing-statute">{w.statute}</p>
    </li>
  )
}

/* ---- help ---------------------------------------------------------- */

function GetHelp({ info, primary }) {
  return (
    <section className="card">
      <h2>Get someone on your side</h2>

      <p>
        You can file on your own, and many people do. You will still be better
        off with someone who has done it before — and for a wage claim that
        usually costs you nothing.
      </p>

      <ul className="filing-bring">
        <li>
          Call {primary.shortName} at <strong>{primary.phone}</strong>. Asking a
          question is not filing a claim, and it does not commit you to
          anything.
        </li>
        <li>
          Look for a legal aid organisation or a workers&rsquo; rights centre
          near you. Many take wage cases for free, and many have staff who speak
          your language.
        </li>
        <li>
          Many wage-and-hour lawyers take these cases on contingency — no fee
          unless you recover. Ask before you assume you cannot afford one.
        </li>
      </ul>

      <p className="filing-warning">{info.notLegalAdvice}</p>
    </section>
  )
}
