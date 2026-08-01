/**
 * Turning a phone photo of a paystub into something a vision model can read.
 *
 * Written in the same spirit as `geo.js`: `captureAndPrepare()` NEVER rejects
 * and never hangs. It resolves to either a prepared image or a tagged reason
 * there isn't one, because every problem here — wrong file, huge file, a codec
 * the browser won't decode — is something the worker can fix if we say what it
 * is. Throwing would just produce a red box that says "Error".
 *
 * Contract (docs/contracts.md, Phase 3 client):
 *   captureAndPrepare(file) -> { dataUrl, width, height, bytes }
 * plus an `ok` discriminant so failures carry the same shape.
 */

/**
 * 2576px on the long edge — deliberately NOT the 1568px that older vision
 * guidance suggests. A paystub is small print inside a dense table; the hour
 * and rate columns are exactly the detail being read, and they are the first
 * thing to dissolve when you downscale. Claude Opus 5 handles high-resolution
 * images, so the extra pixels are spent where they matter.
 */
export const MAX_EDGE = 2576

/** Above this we refuse before decoding — a 40MP HEIC will hang a phone. */
export const MAX_BYTES = 25 * 1024 * 1024

/** High enough that JPEG ringing doesn't eat thin digits; low enough to POST. */
export const JPEG_QUALITY = 0.85

/** Decoding a corrupt file can stall forever in some browsers. */
const DECODE_TIMEOUT_MS = 20_000

function reason(code, detail) {
  switch (code) {
    case 'no-file':
      return 'No photo was chosen.'
    case 'not-an-image':
      return 'That file is not a photo. Pick a JPEG, PNG, HEIC or WebP image of the paystub.'
    case 'too-large':
      return `That photo is ${detail} — larger than the 25 MB limit. Take it again at a lower resolution, or use your phone's built-in crop first.`
    case 'undecodable':
      return 'This browser could not open that image. Try photographing the paystub again, or save it as a JPEG first.'
    case 'timeout':
      return 'Opening that image took too long. Try a smaller photo.'
    case 'unsupported':
      return 'This browser cannot prepare photos. Type the numbers into the form instead — the record is identical.'
    case 'encode-failed':
      return 'The photo could not be re-saved for upload. Try a different image.'
    default:
      return 'That photo could not be prepared.'
  }
}

const fail = (code, detail) => ({ ok: false, code, message: reason(code, detail) })

function formatBytes(n) {
  if (!Number.isFinite(n)) return 'an unknown size'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/* ---- pure helpers (exported so they can be tested without a browser) ---- */

/**
 * The downscale itself. Never upscales: a 900px photo of a paystub stays 900px,
 * because inventing pixels does not invent legibility and only inflates the
 * upload.
 *
 * @returns {{width:number, height:number, scale:number}}
 */
export function fitWithin(width, height, maxEdge = MAX_EDGE) {
  const w = Math.max(1, Math.round(width || 0))
  const h = Math.max(1, Math.round(height || 0))
  const longest = Math.max(w, h)
  if (!Number.isFinite(longest) || longest <= maxEdge) {
    return { width: w, height: h, scale: 1 }
  }
  const scale = maxEdge / longest
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
    scale,
  }
}

/** EXIF orientations 5–8 rotate by a quarter turn, so width and height swap. */
export function orientationSwapsAxes(orientation) {
  return orientation >= 5 && orientation <= 8
}

/**
 * Reads EXIF orientation and the true encoded pixel size out of a JPEG.
 *
 * Only JPEG carries the orientation tag that phones actually use, and only the
 * APP1/Exif segment is walked — this is not a general EXIF parser, and it
 * deliberately reads nothing else. Everything it does not understand yields
 * `orientation: 1`, which is the identity transform, so a parse failure can
 * never rotate a photo that was already upright.
 *
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {{orientation:number, rawWidth:number|null, rawHeight:number|null}}
 */
export function readJpegMeta(buffer) {
  const none = { orientation: 1, rawWidth: null, rawHeight: null }
  const view =
    buffer instanceof Uint8Array
      ? new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
      : buffer instanceof ArrayBuffer
        ? new DataView(buffer)
        : null
  if (!view || view.byteLength < 4) return none
  if (view.getUint16(0, false) !== 0xffd8) return none // not a JPEG

  let orientation = 1
  let rawWidth = null
  let rawHeight = null
  let offset = 2

  while (offset + 4 <= view.byteLength) {
    if (view.getUint8(offset) !== 0xff) {
      offset += 1 // resync over fill bytes rather than giving up
      continue
    }
    const marker = view.getUint8(offset + 1)
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    if (marker === 0xda || marker === 0xd9) break // start of scan / end of image

    const size = view.getUint16(offset + 2, false)
    if (size < 2 || offset + 2 + size > view.byteLength) break
    const segment = offset + 4

    // SOF0..SOF15 (excluding the DHT/JPG/DAC markers) carry the real dimensions.
    const isSof =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    if (isSof && segment + 5 <= view.byteLength) {
      rawHeight = view.getUint16(segment + 1, false)
      rawWidth = view.getUint16(segment + 3, false)
    }

    if (marker === 0xe1 && segment + 6 <= view.byteLength) {
      const isExif =
        view.getUint32(segment, false) === 0x45786966 && // "Exif"
        view.getUint16(segment + 4, false) === 0x0000
      if (isExif) {
        const found = readExifOrientation(view, segment + 6)
        if (found) orientation = found
      }
    }

    offset += 2 + size
  }

  return { orientation, rawWidth, rawHeight }
}

/** Walks the TIFF header inside an Exif APP1 segment for tag 0x0112. */
function readExifOrientation(view, tiffStart) {
  if (tiffStart + 8 > view.byteLength) return null

  const endian = view.getUint16(tiffStart, false)
  if (endian !== 0x4949 && endian !== 0x4d4d) return null
  const little = endian === 0x4949

  if (view.getUint16(tiffStart + 2, little) !== 0x002a) return null
  const ifd0 = tiffStart + view.getUint32(tiffStart + 4, little)
  if (ifd0 + 2 > view.byteLength) return null

  const count = view.getUint16(ifd0, little)
  for (let i = 0; i < count; i += 1) {
    const entry = ifd0 + 2 + i * 12
    if (entry + 12 > view.byteLength) break
    if (view.getUint16(entry, little) === 0x0112) {
      const value = view.getUint16(entry + 8, little)
      return value >= 1 && value <= 8 ? value : null
    }
  }
  return null
}

/**
 * The canvas transform that undoes an EXIF orientation.
 *
 * `dw`/`dh` are the FINAL (already-rotated) canvas dimensions; the returned
 * matrix maps source-space coordinates onto them.
 */
export function orientationTransform(orientation, dw, dh) {
  switch (orientation) {
    case 2:
      return [-1, 0, 0, 1, dw, 0] // mirrored
    case 3:
      return [-1, 0, 0, -1, dw, dh] // 180°
    case 4:
      return [1, 0, 0, -1, 0, dh] // mirrored vertically
    case 5:
      return [0, 1, 1, 0, 0, 0] // mirrored + 90° CCW
    case 6:
      return [0, 1, -1, 0, dw, 0] // 90° CW — the common portrait-phone case
    case 7:
      return [0, -1, -1, 0, dw, dh] // mirrored + 90° CW
    case 8:
      return [0, -1, 1, 0, 0, dh] // 90° CCW
    default:
      return [1, 0, 0, 1, 0, 0]
  }
}

/** Exact decoded size of a base64 data URL, without allocating the bytes. */
export function dataUrlByteLength(dataUrl) {
  if (typeof dataUrl !== 'string') return 0
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return 0
  const b64 = dataUrl.slice(comma + 1)
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding)
}

/* ---- browser plumbing ---------------------------------------------- */

function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => finish({ ok: false, code: 'timeout' }), ms)
    promise.then(
      (value) => finish({ ok: true, value }),
      () => finish({ ok: false, code: 'undecodable' }),
    )
  })
}

function decodeViaImageElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => resolve({ img, revoke: () => URL.revokeObjectURL(url) })
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('decode failed'))
    }
    img.src = url
  })
}

/**
 * Decodes `file` into something drawable, already the right way up.
 *
 * Preferred path is `createImageBitmap(file, { imageOrientation: 'from-image' })`,
 * which applies EXIF orientation during decode — correct for every orientation
 * including the mirrored ones, and it is what every current browser supports.
 *
 * The `<img>` fallback exists for browsers without `createImageBitmap`. There
 * we apply the rotation ourselves, but only after checking whether the browser
 * already did it: a quarter-turn orientation swaps the encoded dimensions, so
 * `naturalWidth === rawHeight` means the browser auto-oriented and rotating
 * again would leave the paystub on its side. Non-swapping orientations (2/3/4)
 * are not detectable this way and are applied unconditionally, which is the
 * right call for the ancient browsers this branch actually serves.
 */
async function decodeOriented(file) {
  if (typeof createImageBitmap === 'function') {
    const outcome = await withTimeout(
      createImageBitmap(file, { imageOrientation: 'from-image' }),
      DECODE_TIMEOUT_MS,
    )
    if (outcome.ok) {
      const bitmap = outcome.value
      return {
        ok: true,
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        orientation: 1,
        release: () => bitmap.close?.(),
      }
    }
    // Safari has historically rejected HEIC here while the <img> path works,
    // so a failure falls through rather than ending the attempt.
  }

  const outcome = await withTimeout(decodeViaImageElement(file), DECODE_TIMEOUT_MS)
  if (!outcome.ok) return { ok: false, code: outcome.code }

  const { img, revoke } = outcome.value
  let orientation = 1
  try {
    const meta = readJpegMeta(await file.arrayBuffer())
    const swaps = orientationSwapsAxes(meta.orientation)
    const alreadyOriented =
      swaps && meta.rawWidth !== null && img.naturalWidth === meta.rawHeight
    orientation = alreadyOriented ? 1 : meta.orientation
  } catch {
    orientation = 1 // unreadable EXIF must never rotate an upright photo
  }

  return {
    ok: true,
    source: img,
    width: img.naturalWidth || img.width,
    height: img.naturalHeight || img.height,
    orientation,
    release: revoke,
  }
}

/* ---- the entry point ------------------------------------------------ */

/**
 * Prepares a chosen photo for `POST /api/extract`.
 *
 * @param {File|Blob} file
 * @returns {Promise<{ok:true, dataUrl:string, width:number, height:number, bytes:number,
 *                    originalWidth:number, originalHeight:number, originalBytes:number}
 *                 | {ok:false, code:string, message:string}>}
 */
export async function captureAndPrepare(file) {
  if (!file) return fail('no-file')

  // Type first, size second: telling someone their PDF is too big is useless.
  const type = typeof file.type === 'string' ? file.type : ''
  if (!type.startsWith('image/')) return fail('not-an-image')

  if (Number.isFinite(file.size) && file.size > MAX_BYTES) {
    return fail('too-large', formatBytes(file.size))
  }

  if (typeof document === 'undefined' || !document.createElement) {
    return fail('unsupported')
  }

  const decoded = await decodeOriented(file)
  if (!decoded.ok) return fail(decoded.code)

  try {
    const swaps = orientationSwapsAxes(decoded.orientation)
    // Measure in DISPLAY space. A portrait photo stored as landscape-plus-
    // orientation-6 must be capped on its tall edge, not its stored wide one.
    const displayW = swaps ? decoded.height : decoded.width
    const displayH = swaps ? decoded.width : decoded.height

    const target = fitWithin(displayW, displayH)

    const canvas = document.createElement('canvas')
    canvas.width = target.width
    canvas.height = target.height

    const ctx = canvas.getContext('2d')
    if (!ctx) return fail('encode-failed')

    // White, not transparent: a PNG with alpha flattens to black under JPEG,
    // and a black rectangle where a paystub should be is not a legible image.
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'

    const [a, b, c, d, e, f] = orientationTransform(
      decoded.orientation,
      target.width,
      target.height,
    )
    ctx.setTransform(a, b, c, d, e, f)

    // Draw dimensions live in SOURCE space, so they swap back for a quarter turn.
    const drawW = swaps ? target.height : target.width
    const drawH = swaps ? target.width : target.height
    ctx.drawImage(decoded.source, 0, 0, drawW, drawH)
    ctx.setTransform(1, 0, 0, 1, 0, 0)

    // Re-encoding through the canvas rewrites the pixels and nothing else, so
    // every EXIF block is dropped on the way out. That is mostly a size win,
    // but it also means the embedded GPS tag most phones write into a photo is
    // never uploaded. A worker photographing a paystub at home should not have
    // their home coordinates leave the device as a side effect. Location in
    // PayTrack is something you opt into per shift, not something a JPEG leaks.
    const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY)
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/jpeg')) {
      return fail('encode-failed')
    }

    return {
      ok: true,
      dataUrl,
      width: target.width,
      height: target.height,
      bytes: dataUrlByteLength(dataUrl),
      originalWidth: displayW,
      originalHeight: displayH,
      originalBytes: Number.isFinite(file.size) ? file.size : 0,
    }
  } catch {
    return fail('encode-failed')
  } finally {
    try {
      decoded.release?.()
    } catch {
      /* releasing a decoded image must never be the thing that breaks this */
    }
  }
}
