/**
 * POST /api/explain -- put the computed analysis into plain words.
 *
 * This route writes nothing. It has no database import beyond the shared
 * computation and no INSERT: an explanation is prose about figures that already
 * exist, and it is an ADDITION to them, never a replacement. The panel above it
 * stands on its own, which is exactly why every failure here is survivable.
 *
 * It also computes nothing. `computeAnalysis` is the same function GET
 * /api/analysis calls, so the explanation is written about the very figures the
 * worker is already looking at. An explainer with its own arithmetic can
 * disagree with the screen, and a worker holding two different amounts for one
 * pay period has a record they cannot use.
 *
 * The statuses are meaningfully different and the client must tell them apart:
 *
 *   400 -- the request is wrong (unknown jurisdiction, missing paystubId, a
 *          paystub with no usable rate). Raised by computeAnalysis and passed
 *          through UNCHANGED. A bad paystubId is a client mistake, not an
 *          upstream outage, and reporting it as 502 would send an operator
 *          hunting a provider that is working fine.
 *   404 -- no such paystub for this worker. Also straight from computeAnalysis.
 *   503 -- the explainer is not enabled on this server (no API key). A
 *          configuration state, not a fault. `fallback: "analysis"` tells the UI
 *          to keep showing what it already has without presenting a failure.
 *   502 -- the explainer is enabled but produced nothing usable: the upstream
 *          call failed, OR the answer failed validation and was thrown away.
 *          Both reach the worker identically -- there is no explanation, the
 *          figures are unaffected -- so they share a status. A rejected answer
 *          is emphatically not a 200 with a warning attached: a warning still
 *          puts a wrong number in front of someone who may hand it to a labor
 *          commissioner.
 *
 * Never 500 for a provider problem: neither an unset env var nor somebody
 * else's downtime is an internal fault of this service, and reporting them as
 * one buries real faults in the logs.
 */

import { Router } from 'express';

import { requireWorker } from '../lib/worker.js';
import { computeAnalysis } from '../lib/analysis.js';
import {
  EXPLANATION_ERROR_CODES,
  MODEL,
  explain,
  isConfigured,
} from '../lib/explainProvider.js';

const router = Router();

// Worker-scoped like every other router, applied here so identity is enforced
// regardless of where index.js mounts this. The explanation is about one
// worker's wage record, and computeAnalysis is scoped by worker id -- which is
// also what stops a paystubId from another worker's ledger being explained.
router.use(requireWorker);

const NOT_CONFIGURED_BODY = Object.freeze({
  error:
    'The plain-language explainer is not enabled on this server. The analysis above is complete and fully usable without it -- every figure in it comes from your own logged hours and the pay statement you entered.',
  fallback: 'analysis',
});

// ---------------------------------------------------------------------------
// POST /api/explain  { paystubId, jurisdiction }
// ---------------------------------------------------------------------------
router.post('/', async (req, res, next) => {
  const body = req.body;

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'body must be a JSON object' });
  }

  let result;
  try {
    // Run before the isConfigured check, matching /api/extract's ordering:
    // input problems are reported as input problems even when the feature
    // itself is switched off. Telling a worker "not enabled" when what they
    // actually sent was a paystub id that does not exist would send them
    // looking in the wrong place.
    result = await computeAnalysis({
      workerId: req.workerId,
      paystubIdRaw: body.paystubId,
      jurisdiction: body.jurisdiction,
    });
  } catch (err) {
    // A throw here is the rule engine failing its own invariants (hour buckets
    // that do not sum), or the database being down. Those ARE internal faults,
    // so they go to the error handler and become a 500 -- unlike anything the
    // provider does.
    return next(err);
  }

  // Passed through byte for byte. The 400/404 bodies belong to computeAnalysis
  // and mean the same thing here as they do on GET /api/analysis.
  if (result.error) return res.status(result.httpStatus).json(result.error);

  // Checked before the call rather than only catching the thrown error, so the
  // ordinary "switched off" state costs nothing and can never be mistaken for
  // an outage. The provider throws for it too -- belt and braces, because an
  // invented explanation is the one thing that must never happen.
  if (!isConfigured()) {
    return res.status(503).json(NOT_CONFIGURED_BODY);
  }

  try {
    const explanation = await explain(result.analysis);

    return res.status(200).json({
      source: 'llm',
      model: MODEL,
      explanation,
    });
  } catch (err) {
    if (err?.code === EXPLANATION_ERROR_CODES.NOT_CONFIGURED) {
      return res.status(503).json({ error: err.message, fallback: 'analysis' });
    }

    // Everything else -- provider failure, a rejected answer, or an unexpected
    // throw -- is a 502. The worker gets prose and their unchanged figures; the
    // operator gets the cause, which for a rejection names the exact tokens
    // that did not trace to the analysis.
    console.error('[explain]', err?.code ?? 'unknown', err?.cause ?? err);

    const message =
      err?.code === EXPLANATION_ERROR_CODES.PROVIDER_FAILURE ||
      err?.code === EXPLANATION_ERROR_CODES.REJECTED
        ? err.message
        : 'The explainer is unavailable right now. The analysis above is complete and unchanged -- it does not depend on this.';

    return res.status(502).json({ error: message, fallback: 'analysis' });
  }
});

export default router;
