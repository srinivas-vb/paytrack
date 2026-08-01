/**
 * Talking to POST /api/extract, and translating every way it can decline into
 * something a worker can act on.
 *
 * Lives apart from the component for two reasons. It is the piece worth testing
 * without a browser -- the whole point is that EVERY refusal lands the worker at
 * manual entry, and that is an invariant you want swept over every status code,
 * not eyeballed. And a module that exports non-components alongside a component
 * breaks React Fast Refresh.
 */
import * as api from './api.js'
import { getWorkerId } from './workerId.js'

const EXTRACT_TIMEOUT_MS = 60_000
const BASE = import.meta.env.VITE_API_URL || ''

/**
 * `POST /api/extract`.
 *
 * Written directly rather than through `api.js` because this caller needs the
 * HTTP status itself — 503 and 502 mean genuinely different things to the
 * worker and must be worded differently. It throws the same `ApiError` /
 * `NetworkError` types so `api.describeError` still applies, and sends the same
 * `X-Worker-Id` header every other request does.
 *
 * The endpoint is being built in parallel; this is written against the contract
 * in docs/contracts.md, so a 404 (route not deployed yet) lands in the same
 * "use the form" branch as any other refusal.
 *
 * Exported, with `describeRefusal` below, so the status routing that decides
 * what a worker is told can be tested against mocked responses without a
 * browser. Nothing else imports them.
 */
export async function postExtract(imageDataUrl) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), EXTRACT_TIMEOUT_MS)

  let res
  try {
    res = await fetch(`${BASE}/api/extract`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Worker-Id': getWorkerId(),
      },
      body: JSON.stringify({ imageDataUrl }),
      signal: controller.signal,
    })
  } catch (cause) {
    throw new api.NetworkError(
      controller.signal.aborted
        ? 'Reading the photo took too long. Nothing was saved.'
        : 'Could not reach the server to read the photo.',
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
 * Every non-success path lands here, and every one of them routes to manual
 * entry. The only thing that changes between them is the honest reason.
 *
 * 503 is the important one: the contract says the server returns it, with
 * `fallback: "manual"`, when extraction simply is not switched on. Nothing has
 * gone wrong in that case, so it is not worded as though something has. No
 * apology, no "unfortunately", no red.
 */
export function describeRefusal(err) {
  if (err instanceof api.ApiError) {
    if (err.status === 503 || err?.body?.fallback === 'manual') {
      return {
        kind: 'manual',
        title: 'Reading photos is switched off in this build.',
        body: 'Type the figures from the paystub into the form below. That is the ordinary way to add one, and it produces exactly the same record — the photo path only saves you the typing.',
      }
    }
    if (err.status === 502) {
      return {
        kind: 'manual',
        title: 'The reading service did not answer.',
        body: 'Something upstream of PayTrack failed, so no figures came back. Nothing was saved and nothing was changed. Type them into the form below — it works whether or not that service ever answers.',
      }
    }
    if (err.status === 404) {
      return {
        kind: 'manual',
        title: 'Photo reading is not available here.',
        body: 'This build has no reader to send the photo to. Type the figures into the form below instead.',
      }
    }
    if (err.status === 413) {
      return {
        kind: 'manual',
        title: 'That photo was too large to send.',
        body: 'Try again with a smaller or less zoomed-in photo, or type the figures into the form below.',
      }
    }
    return {
      kind: 'manual',
      title: 'The photo could not be read.',
      body: `${api.describeError(err)} Nothing was saved. Type the figures into the form below instead.`,
    }
  }

  return {
    kind: 'manual',
    title: 'The photo could not be sent.',
    body: `${api.describeError(err)} Nothing was saved. Type the figures into the form below instead.`,
  }
}
