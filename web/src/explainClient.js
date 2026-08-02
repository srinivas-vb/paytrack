/**
 * Talking to POST /api/explain, and translating every way it can decline into
 * something that leaves the worker's figures standing.
 *
 * Lives apart from the component for the same two reasons extractClient.js
 * does. The status routing is the part worth testing without a browser --
 * the invariant here is that NO refusal ever damages the analysis already on
 * screen, and that is a claim you want swept over every status code rather
 * than eyeballed. And a module exporting non-components beside a component
 * breaks React Fast Refresh.
 *
 * The endpoint is being built in parallel with this file, so it is written
 * against docs/contracts.md rather than against a running server. A 404 (route
 * not mounted yet) therefore has to land exactly where a 503 lands: this is a
 * capability that is off, not a thing that broke.
 */
import * as api from './api.js'
import { getWorkerId } from './workerId.js'

// A model writing four paragraphs is slower than any other call this app
// makes -- roughly seven seconds, and worse on a phone on cell data. Timing
// out at the usual 15s would turn "slow" into "broken" for people on the
// worst connections, who are not a rare case here.
const EXPLAIN_TIMEOUT_MS = 45_000
const BASE = import.meta.env.VITE_API_URL || ''

/**
 * `POST /api/explain`.
 *
 * Written directly rather than through `api.js` because this caller needs the
 * HTTP status itself: 503 means a feature is switched off and 502 means an
 * attempt failed, and a worker must be told those two things differently. It
 * throws the same `ApiError` / `NetworkError` types, so `api.describeError`
 * still applies, and sends the same `X-Worker-Id` header as every other
 * request.
 */
export async function postExplain({ paystubId, jurisdiction }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), EXPLAIN_TIMEOUT_MS)

  let res
  try {
    res = await fetch(`${BASE}/api/explain`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Worker-Id': getWorkerId(),
      },
      body: JSON.stringify({ paystubId, jurisdiction }),
      signal: controller.signal,
    })
  } catch (cause) {
    throw new api.NetworkError(
      controller.signal.aborted
        ? 'Writing the explanation took too long. Your figures were not changed.'
        : 'Could not reach the server to ask for an explanation.',
      { cause },
    )
  } finally {
    clearTimeout(timer)
  }

  const text = await res.text()
  let payload = null
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = null
    }
  }

  if (!res.ok) {
    const message =
      (payload && typeof payload.error === 'string' && payload.error) ||
      `The server refused the request (${res.status}).`
    throw new api.ApiError(message, { status: res.status, body: payload })
  }
  return payload ?? {}
}

/**
 * Every non-success path lands here, and not one of them is a problem for the
 * worker, because the analysis they came for is already on the screen above
 * this panel and is untouched by any of it. So every message says two things:
 * what happened, and that their figures are unaffected.
 *
 * `kind` separates the two situations that deserve different offers:
 *
 *   'off'    the capability is not switched on in this build. Nothing went
 *            wrong. There is nothing to retry, and offering a retry button
 *            would imply otherwise.
 *   'failed' an attempt was made and did not produce anything usable. Trying
 *            again is reasonable, so it is offered.
 *
 * The 503 wording is the one that matters most. The contract says the server
 * returns it, with `fallback: "analysis"`, when the explainer simply is not
 * configured -- so it is not worded as a failure, gets no apology, no
 * "unfortunately", and no red. A worker who never sees this panel work has
 * lost nothing: the figures are the product, this is a paraphrase of them.
 *
 * Note that `fallback: "analysis"` cannot be used to tell these apart: the
 * contract puts that same flag on the 502 as well, because it means "the
 * analysis is still good", which is true of both. Only the status separates
 * "never switched on" from "tried and came back empty", so 502 is matched
 * FIRST and the flag is never treated as a signal on its own.
 */
export function describeExplainRefusal(err) {
  if (err instanceof api.ApiError) {
    if (err.status === 502) {
      return {
        kind: 'failed',
        title: 'No explanation came back this time.',
        body: 'PayTrack checks every explanation against your own figures and drops any that disagrees, so either nothing came back or what came back did not match and was thrown away. Your figures above are untouched. You can try again.',
      }
    }
    if (err.status === 503) {
      return {
        kind: 'off',
        title: 'Plain-words explanations are switched off in this build.',
        body: 'Nothing is missing from your figures. The amounts, the week-by-week breakdown and the statutes above are the whole result — this panel only re-states them in ordinary sentences. Everything above works, prints and files exactly as it is.',
      }
    }
    if (err.status === 404) {
      return {
        kind: 'off',
        title: 'This build has no explainer to ask.',
        body: 'Your figures above are complete and unaffected. The plain-words version is an extra that is not installed here — nothing on this page depends on it.',
      }
    }
    return {
      kind: 'failed',
      title: 'The explanation could not be written.',
      body: `${api.describeError(err)} Your figures above are untouched.`,
    }
  }

  return {
    kind: 'failed',
    title: 'The explanation could not be requested.',
    body: `${api.describeError(err)} Your figures above are untouched.`,
  }
}
