/**
 * POST /api/extract -- read a photo of a paystub, return values to REVIEW.
 *
 * This route writes nothing. It has no database import and no INSERT, and that
 * is deliberate: extraction produces a proposal, and the only way a paystub
 * enters the record is POST /api/paystubs, after a human has checked every
 * field against the document in their hand. A silently-wrong OCR read that
 * nobody was asked to confirm is the worst outcome this product can produce.
 *
 * The three failure statuses are meaningfully different and the client must be
 * able to tell them apart:
 *
 *   400 -- the request is wrong (not a data URL, not an image, too big). The
 *          worker can fix it by retaking the photo. No upstream call was made.
 *   503 -- extraction is not available on this server at all (no API key). This
 *          is a configuration state, not a fault: nothing is broken, the feature
 *          is simply off. `fallback: "manual"` tells the UI to route straight to
 *          the manual form without presenting a failure.
 *   502 -- extraction is available but the upstream call failed. Also
 *          `fallback: "manual"`, because from the worker's side the remedy is
 *          identical -- but it is a different status because a 503 here is a
 *          permanent, expected state and a 502 is an outage worth alerting on.
 *
 * Never 500: neither an unset env var nor somebody else's downtime is an
 * internal fault of this service, and reporting them as one would bury real
 * faults in the logs.
 */

import { Router } from 'express';

import { requireWorker } from '../lib/worker.js';
import {
  EXTRACTION_ERROR_CODES,
  MAX_IMAGE_BYTES,
  extractPaystub,
  isConfigured,
  parseImageDataUrl,
} from '../lib/extractProvider.js';

const router = Router();

// Worker-scoped like every other router, applied here so identity is enforced
// regardless of where index.js mounts this. Extraction stores nothing, but the
// worker id is still required: this endpoint spends money and touches an image
// of somebody's wage statement, and both of those want an identity attached.
router.use(requireWorker);

/**
 * Crude upper bound on the decoded image, checked before anything else looks at
 * the bytes. The provider enforces a tighter, format-driven limit of its own;
 * this one exists to reject an obviously-wrong payload cheaply and clearly.
 *
 * There were three competing ceilings here and a worker could be told any of
 * three different numbers depending on which fired: this route's 15 MB, the
 * provider's 5 MB, and express.json's 12 MB body limit (which lands at ~9 MB of
 * decoded image, since base64 inflates by ~4/3, and answers 413).
 *
 * Now there is one: the provider's MAX_IMAGE_BYTES, imported rather than
 * restated. It is the real constraint (the vision API's own per-block limit)
 * and it is the smallest, so it fires first and the message a worker sees names
 * the number that actually applies.
 *
 * In practice none of this is reached from the app -- the client downscales to
 * 2576px JPEG, which lands well under a megabyte. This guards direct callers
 * and client bugs.
 */
const MAX_DECODED_BYTES = MAX_IMAGE_BYTES;

const NOT_CONFIGURED_BODY = Object.freeze({
  error:
    'Automatic paystub reading is not enabled on this server. Enter the paystub by hand -- manual entry is fully supported, takes about a minute, and produces exactly the same record with the same legal weight.',
  fallback: 'manual',
});

function mb(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1);
}

// ---------------------------------------------------------------------------
// POST /api/extract
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  const body = req.body;

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'body must be a JSON object' });
  }

  const { imageDataUrl } = body;

  if (imageDataUrl === undefined || imageDataUrl === null) {
    return res.status(400).json({ error: 'imageDataUrl is required' });
  }
  if (typeof imageDataUrl !== 'string') {
    return res.status(400).json({ error: 'imageDataUrl must be a data URL string' });
  }

  // Same parser the provider uses, so the route and the provider can never
  // disagree about what counts as an acceptable image.
  const parsed = parseImageDataUrl(imageDataUrl);
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }

  if (parsed.byteLength > MAX_DECODED_BYTES) {
    return res.status(400).json({
      error: `That image is ${mb(parsed.byteLength)} MB, over the ${mb(MAX_DECODED_BYTES)} MB limit. Retake it at a smaller size, or enter the paystub by hand.`,
    });
  }

  // Checked before the call rather than only catching the thrown error, so the
  // common configuration state costs nothing and cannot be mistaken for an
  // outage. The provider throws for it too -- belt and braces, because a
  // fabricated result is the one thing that must never happen.
  if (!isConfigured()) {
    return res.status(503).json(NOT_CONFIGURED_BODY);
  }

  try {
    const extraction = await extractPaystub({ imageDataUrl });

    // The ExtractedPaystub itself, unwrapped, per docs/contracts.md. Nothing
    // was saved; the client pre-fills the manual form with this and the worker
    // confirms each field before POSTing to /api/paystubs.
    return res.status(200).json(extraction);
  } catch (err) {
    switch (err?.code) {
      case EXTRACTION_ERROR_CODES.NOT_CONFIGURED:
      case EXTRACTION_ERROR_CODES.DEPENDENCY_MISSING:
        return res.status(503).json({ error: err.message, fallback: 'manual' });

      case EXTRACTION_ERROR_CODES.INVALID_IMAGE:
        // A fixable input problem; no fallback hint, because retaking the photo
        // is the better next step and the manual form is always available.
        return res.status(400).json({ error: err.message });

      default: {
        // Provider failure, or an unexpected throw. Log the cause -- the worker
        // gets prose, the operator gets the stack.
        console.error('[extract]', err?.cause ?? err);
        const message =
          err?.code === EXTRACTION_ERROR_CODES.PROVIDER_FAILURE
            ? err.message
            : 'The paystub reader is unavailable right now. Enter the paystub by hand instead -- manual entry produces exactly the same record.';
        return res.status(502).json({ error: message, fallback: 'manual' });
      }
    }
  }
});

export default router;
