import { useEffect, useState } from 'react'
import { postExplain, describeExplainRefusal } from '../explainClient.js'
import './Explain.css'

/**
 * The analysis, said out loud.
 *
 * Four things here are product decisions rather than layout choices:
 *
 *   1. Nothing is fetched on mount. This costs an API call and takes several
 *      seconds, and the worker did not ask for it by arriving on the page.
 *      It sits behind one button, and once an explanation is on screen it
 *      stays there.
 *   2. There is a hard, visible boundary around the model's words. A worker
 *      must never have to wonder which text on this screen is the computed
 *      record and which is a machine's paraphrase of it. The figures above
 *      are evidence; everything inside the dashed box below is not, and the
 *      page says so in both directions -- before the box and after it.
 *   3. `why` and `whatThisIsNot` are made structurally different, not just
 *      differently worded. Reasons are numbered, on the page, with the violet
 *      rule this app uses for statutory reasoning. Limits sit in a bordered,
 *      tinted block with a different marker and a different colour. Someone
 *      skimming on a phone cannot mistake a limit for a reason.
 *   4. Every refusal keeps the analysis intact and says so. A 503 means this
 *      feature is off, which is not a failure and is not dressed as one --
 *      the figures above are the product, this panel is a convenience.
 *
 * The panel is an addition. Remove it, break it, or never configure it, and
 * the screen above is unchanged and complete.
 */
export default function ExplainPanel({ paystubId, jurisdiction }) {
  // 'idle' -> 'loading' -> 'ready' | 'declined'
  const [status, setStatus] = useState('idle')
  const [explanation, setExplanation] = useState(null)
  const [outcome, setOutcome] = useState(null)

  // An explanation describes ONE paystub under ONE law. The moment either
  // changes, these sentences no longer describe the figures they sit under,
  // and a paragraph about last fortnight's overtime parked beneath this
  // fortnight's total is exactly the kind of quiet contradiction that makes a
  // record unusable. So it goes, and the worker asks again if they want it.
  useEffect(() => {
    setStatus('idle')
    setExplanation(null)
    setOutcome(null)
  }, [paystubId, jurisdiction])

  async function handleExplain() {
    if (status === 'loading') return
    setStatus('loading')
    setOutcome(null)

    try {
      const result = await postExplain({ paystubId, jurisdiction })
      const shaped = toExplanation(result)

      // An empty or malformed reply is not an explanation. Rendering a box
      // with a heading and nothing in it would be worse than saying nothing.
      if (!shaped.usable) {
        setOutcome({
          kind: 'failed',
          title: 'Nothing usable came back.',
          body: 'The reply did not contain an explanation. Your figures above are untouched. You can try again.',
        })
        setStatus('declined')
        return
      }

      setExplanation(shaped)
      setStatus('ready')
    } catch (err) {
      setOutcome(describeExplainRefusal(err))
      setStatus('declined')
    }
  }

  return (
    <section className="card">
      <h2>In plain words</h2>

      {status === 'ready' && explanation ? (
        <Explanation explanation={explanation} />
      ) : (
        <>
          <p className="hint explain-intro">
            The figures above are the result. If it would help to have them as
            ordinary sentences — something you could read out loud to a labor
            commissioner, or send to a lawyer — PayTrack can ask a language
            model to put them into words. It takes a few seconds and it changes
            nothing above.
          </p>

          {status === 'declined' && outcome ? (
            <Declined outcome={outcome} onRetry={handleExplain} />
          ) : (
            <>
              <button
                type="button"
                className="btn btn-primary btn-wide"
                onClick={handleExplain}
                disabled={status === 'loading'}
              >
                {status === 'loading'
                  ? 'Writing it out…'
                  : 'Explain this in plain words'}
              </button>

              {status === 'loading' ? (
                <p className="status loading explain-waiting" aria-live="polite">
                  Putting your figures into sentences. This usually takes a few
                  seconds.
                </p>
              ) : (
                <p className="explain-note">
                  The model is handed the figures above and is not allowed to
                  work out any of its own. If what it writes disagrees with
                  them, PayTrack throws it away rather than showing you two
                  different answers.
                </p>
              )}
            </>
          )}
        </>
      )}
    </section>
  )
}

/* ---- shaping the response ------------------------------------------- */

function cleanLine(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function cleanList(value) {
  return Array.isArray(value) ? value.map(cleanLine).filter(Boolean) : []
}

/**
 * Turns the wire shape into exactly the four parts this panel renders,
 * dropping anything malformed rather than printing `[object Object]` into a
 * document a worker may hand to an agency.
 *
 * `usable` is deliberately generous — a headline alone, or reasons alone, is
 * still worth showing — but an empty shell is not.
 */
function toExplanation(payload) {
  const raw =
    payload?.explanation && typeof payload.explanation === 'object'
      ? payload.explanation
      : {}

  const headline = cleanLine(raw.headline)
  const why = cleanList(raw.why)
  const whatThisIsNot = cleanList(raw.whatThisIsNot)
  const nextStep = cleanLine(raw.nextStep)

  return {
    headline,
    why,
    whatThisIsNot,
    nextStep,
    model: cleanLine(payload?.model),
    usable: headline !== '' || why.length > 0,
  }
}

/* ---- the explanation ------------------------------------------------- */

/**
 * The model's words, fenced.
 *
 * The frame is PayTrack speaking; the dashed box inside it is the model
 * speaking, and nothing crosses. That boundary is the whole point of this
 * component: the figures above are evidence and these sentences are not, so
 * the difference has to be visible at a glance and audible to a screen reader
 * rather than inferable from tone.
 */
function Explanation({ explanation }) {
  const { headline, why, whatThisIsNot, nextStep, model } = explanation

  return (
    <div className="explain-block">
      <div className="explain-mark">
        <p className="explain-mark-label">written by a machine</p>
        <p className="explain-mark-body">
          Everything inside the dashed box below was written by a language
          model from the figures above. Those figures are your record. These
          sentences are a description of them and are not evidence of anything
          on their own.
        </p>
      </div>

      <div
        className="explain-prose"
        role="region"
        aria-label="Plain-words explanation, written by a language model"
      >
        {headline ? <p className="explain-headline">{headline}</p> : null}

        {why.length > 0 ? (
          <>
            <h3 className="explain-head">Why the figures came out this way</h3>
            <ol className="explain-reasons">
              {why.map((reason, i) => (
                <li key={i}>{reason}</li>
              ))}
            </ol>
          </>
        ) : null}

        {/* Limits are not reasons. Different block, different colour,
            different marker, different heading -- so a worker skimming on a
            phone cannot read a limitation as an argument in their favour. */}
        {whatThisIsNot.length > 0 ? (
          <div className="explain-limits">
            <h3 className="explain-limits-head">
              What this does not tell you
            </h3>
            <ul className="explain-limit-list">
              {whatThisIsNot.map((limit, i) => (
                <li key={i}>{limit}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {nextStep ? (
          <div className="explain-next">
            <p className="explain-next-label">what to do next</p>
            <p className="explain-next-body">{nextStep}</p>
          </div>
        ) : null}
      </div>

      <p className="explain-foot">
        {model ? `Written by ${model}. ` : ''}It was given your figures and was
        not allowed to work out any of its own — every amount it mentions comes
        from the analysis above. It is not a lawyer, it has not read your
        paystub, and it cannot tell you whether to file or what you would win.
      </p>
    </div>
  )
}

/* ---- refusals -------------------------------------------------------- */

/**
 * Deliberately not `.status bad`.
 *
 * The commonest way to reach this block is a 503 meaning the explainer is not
 * switched on, and nothing has gone wrong in that case at all. Red would tell
 * the worker their evidence is damaged when the only thing missing is an
 * optional paraphrase of it.
 */
function Declined({ outcome, onRetry }) {
  return (
    <div className="explain-route" role="status">
      <p className="explain-route-title">{outcome.title}</p>
      <p className="explain-route-body">{outcome.body}</p>
      {outcome.kind === 'failed' ? (
        <button type="button" className="btn btn-wide" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  )
}
