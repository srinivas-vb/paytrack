import { Router } from 'express';

import { requireWorker } from '../lib/worker.js';
import { computeAnalysis } from '../lib/analysis.js';

const router = Router();
router.use(requireWorker);

/**
 * GET /api/analysis?paystubId=<id>&jurisdiction=<federal|california>
 *
 * A thin wrapper. The computation lives in lib/analysis.js so that
 * /api/explain runs exactly the same numbers rather than deriving its own --
 * an explainer that disagrees with the screen gives a worker a record they
 * cannot use.
 */
router.get('/', async (req, res, next) => {
  try {
    const result = await computeAnalysis({
      workerId: req.workerId,
      paystubIdRaw: req.query.paystubId,
      jurisdiction: req.query.jurisdiction,
    });

    if (result.error) return res.status(result.httpStatus).json(result.error);
    return res.json(result.analysis);
  } catch (err) {
    return next(err);
  }
});

export default router;
