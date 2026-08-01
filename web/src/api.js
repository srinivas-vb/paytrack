/**
 * Thin fetch wrapper for the Phase 1 API described in docs/contracts.md.
 *
 * Everything here is written against that contract, not against a running
 * server. Two error types, because the UI genuinely needs to tell them apart:
 * a NetworkError means "try again", an ApiError means "the server understood
 * you and said no".
 */

import { getWorkerId } from './workerId.js'

// In dev, vite.config.js proxies /api -> localhost:3001, so this stays empty.
// In production, set VITE_API_URL to the Render API URL.
const BASE = import.meta.env.VITE_API_URL || ''

const DEFAULT_TIMEOUT_MS = 15_000

export class ApiError extends Error {
  constructor(message, { status, body } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status ?? 0
    this.body = body ?? null
  }
}

export class NetworkError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'NetworkError'
  }
}

async function request(path, { method = 'GET', body, timeoutMs } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(),
    timeoutMs ?? DEFAULT_TIMEOUT_MS,
  )

  let res
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        'X-Worker-Id': getWorkerId(),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (cause) {
    throw new NetworkError(
      controller.signal.aborted
        ? 'The server took too long to answer. Your record was not changed.'
        : 'Could not reach the server. Check your connection and try again.',
      { cause },
    )
  } finally {
    clearTimeout(timer)
  }

  if (res.status === 204) return null

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
    throw new ApiError(message, { status: res.status, body: payload })
  }

  if (payload === null && text) {
    throw new ApiError('The server sent a reply we could not read.', {
      status: res.status,
    })
  }

  return payload
}

/* ---- workplaces ---------------------------------------------------- */

export function listWorkplaces() {
  return request('/api/workplaces').then((r) => r?.workplaces ?? [])
}

export function createWorkplace({ label, lat, lng }) {
  return request('/api/workplaces', {
    method: 'POST',
    body: { label, lat, lng },
  }).then((r) => r?.workplace ?? null)
}

export function deleteWorkplace(id) {
  return request(`/api/workplaces/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}

/* ---- shifts -------------------------------------------------------- */

export function listShifts(limit = 50) {
  return request(`/api/shifts?limit=${limit}`).then((r) => ({
    shifts: r?.shifts ?? [],
    openShift: r?.openShift ?? null,
  }))
}

export function clockIn(gps) {
  return request('/api/shifts/clock-in', {
    method: 'POST',
    body: { gps: gps ?? null },
  }).then((r) => r?.shift ?? null)
}

export function clockOut(gps) {
  return request('/api/shifts/clock-out', {
    method: 'POST',
    body: { gps: gps ?? null },
  }).then((r) => r?.shift ?? null)
}

export function addRetroactiveShift({ clockIn: start, clockOut: end, gps }) {
  return request('/api/shifts/retroactive', {
    method: 'POST',
    body: { clockIn: start, clockOut: end, gps: gps ?? null },
  }).then((r) => r?.shift ?? null)
}

export function verifyChain() {
  return request('/api/shifts/verify')
}

/* ---- paystubs ------------------------------------------------------ */

export function listPaystubs() {
  return request('/api/paystubs').then((r) => r?.paystubs ?? [])
}

/**
 * `presentFields` is deliberately tri-state, matching the server:
 * omit it entirely when the worker did not go through the checklist, so an
 * unanswered form is never reported as nine missing elements.
 */
export function createPaystub({
  periodStart,
  periodEnd,
  paidHours,
  paidRate,
  grossPay,
  presentFields,
}) {
  return request('/api/paystubs', {
    method: 'POST',
    body: {
      periodStart,
      periodEnd,
      paidHours,
      paidRate,
      grossPay,
      ...(presentFields === undefined || presentFields === null
        ? {}
        : { presentFields }),
    },
  }).then((r) => r?.paystub ?? null)
}

export function deletePaystub(id) {
  return request(`/api/paystubs/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}

/* ---- analysis ------------------------------------------------------ */

/**
 * The rule engine's verdict for one paystub under one jurisdiction.
 *
 * Not yet built at the time of writing. A 404 therefore means either "no such
 * paystub" or "this endpoint does not exist yet", and the caller renders a
 * "not available" state for both rather than crashing on an absent shape.
 */
export function getAnalysis({ paystubId, jurisdiction }) {
  const params = new URLSearchParams({
    paystubId: String(paystubId),
    jurisdiction,
  })
  return request(`/api/analysis?${params.toString()}`)
}

/* ---- error copy ---------------------------------------------------- */

/** Turns any thrown value into one plain sentence a stressed person can read. */
export function describeError(err) {
  if (!err) return 'Something went wrong.'
  if (err instanceof NetworkError) return err.message

  if (err instanceof ApiError) {
    if (err.status === 400 && /worker-id/i.test(err.message)) {
      return 'This device could not be identified. Reload the page and try again.'
    }
    if (err.status === 404) return err.message
    if (err.status >= 500) {
      return 'The server hit a problem. Nothing was saved — try again in a moment.'
    }
    return err.message
  }

  return err.message || 'Something went wrong.'
}
