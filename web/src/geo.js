/**
 * Browser geolocation, made optional by construction.
 *
 * `requestPosition()` NEVER rejects and never hangs. It resolves to either a
 * reading or a reason there isn't one. Every caller is expected to carry on
 * without a location — a shift with no GPS is a perfectly valid shift, and a
 * clock-in that waits on a permission prompt is a clock-in that doesn't happen.
 */

const DEFAULT_TIMEOUT_MS = 8000

export const geolocationSupported = () =>
  typeof navigator !== 'undefined' && 'geolocation' in navigator

function reason(code) {
  switch (code) {
    case 'unsupported':
      return 'This browser cannot share a location.'
    case 'denied':
      return 'Location permission is off, so this was saved without one.'
    case 'unavailable':
      return 'Your location could not be found, so this was saved without one.'
    case 'timeout':
      return 'Finding your location took too long, so this was saved without one.'
    default:
      return 'No location was attached.'
  }
}

/**
 * @returns {Promise<{ok:true, lat:number, lng:number, accuracyM:number|null}
 *                 | {ok:false, code:string, message:string}>}
 */
export function requestPosition({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!geolocationSupported()) {
    return Promise.resolve({
      ok: false,
      code: 'unsupported',
      message: reason('unsupported'),
    })
  }

  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(guard)
      resolve(value)
    }

    // Belt and braces: some browsers never fire either callback when a
    // permission prompt is dismissed, so we keep our own clock.
    const guard = setTimeout(
      () => finish({ ok: false, code: 'timeout', message: reason('timeout') }),
      timeoutMs + 500,
    )

    navigator.geolocation.getCurrentPosition(
      (pos) =>
        finish({
          ok: true,
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracyM:
            typeof pos.coords.accuracy === 'number'
              ? Math.round(pos.coords.accuracy)
              : null,
        }),
      (err) => {
        const code =
          err && err.code === 1
            ? 'denied'
            : err && err.code === 3
              ? 'timeout'
              : 'unavailable'
        finish({ ok: false, code, message: reason(code) })
      },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30_000 },
    )
  })
}
