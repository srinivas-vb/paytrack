const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves the worker identity from the X-Worker-Id header onto req.workerId.
 *
 * There is no auth in this prototype -- a client-generated UUID held in
 * localStorage is the whole identity model. That is a deliberate scope cut for
 * a 44-hour build, and it is stated in the README rather than hidden.
 *
 * Be honest about it if asked: anyone who knows a worker's UUID can read and
 * append to that worker's ledger. Real deployment needs authentication. What
 * this does preserve is the property that matters most here -- the EMPLOYER
 * never writes to the ledger and has no view into it.
 */
export function requireWorker(req, res, next) {
  const id = req.get('X-Worker-Id');

  if (!id || !UUID_RE.test(id)) {
    return res.status(400).json({ error: 'missing or invalid X-Worker-Id' });
  }

  req.workerId = id.toLowerCase();
  next();
}
