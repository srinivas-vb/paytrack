import 'dotenv/config';
import express from 'express';
import cors from 'cors';

import { dbHealthy } from './db.js';
import { migrate } from './migrate.js';

const app = express();
const PORT = process.env.PORT || 3001;

// ---------------------------------------------------------------------------
// CORS. Configured on day one deliberately: the static site and the web
// service live on different Render domains, and discovering this at 3am is a
// classic hackathon time sink.
//
// ALLOWED_ORIGINS is a comma-separated list. Unset => allow all (dev only).
// ---------------------------------------------------------------------------
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim())
  : null;

app.use(
  cors({
    origin(origin, callback) {
      if (!allowedOrigins) return callback(null, true);
      if (!origin) return callback(null, true); // curl, server-to-server
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
  })
);

// Paystub images arrive base64-encoded. They're downscaled client-side to
// ~1568px before upload, but leave headroom.
app.use(express.json({ limit: '12mb' }));

// Liveness -- Render's healthCheckPath. 200 whenever the process is up.
// Deliberately does NOT check the database: a transient DB blip should not
// convince Render the service is dead and trigger a restart loop.
app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'paytrack-api' });
});

// Readiness -- what the app actually calls. Reports DB reachability and
// returns 503 when the database is down, so the UI can say so plainly.
//
// Everything the frontend calls lives under /api, so the dev proxy and the
// production VITE_API_URL behave identically with no path rewriting to get wrong.
app.get('/api/health', async (_req, res) => {
  const db = await dbHealthy();
  res.status(db ? 200 : 503).json({
    ok: db,
    service: 'paytrack-api',
    db,
    time: new Date().toISOString(),
  });
});

app.get('/', (_req, res) => {
  res.json({ service: 'paytrack-api', see: '/api/health' });
});

// ---------------------------------------------------------------------------
// Phase 1+ routes mount here:
//   /api/shifts      clock in/out, hash chain, retroactive entry
//   /api/workplaces  worker-defined locations
//   /api/paystubs    vision extraction
//   /api/analysis    rule engine output
//   /api/explain     LLM legal explainer
// ---------------------------------------------------------------------------

app.use((_req, res) => res.status(404).json({ error: 'not found' }));

app.use((err, _req, res, _next) => {
  console.error('[api]', err);
  res.status(500).json({ error: err.message || 'internal error' });
});

// Apply the schema before accepting traffic. Runs over Render's internal
// network in production, so the Postgres IP allow-list never comes into it.
await migrate();

app.listen(PORT, () => {
  console.log(`[api] listening on :${PORT}`);
  console.log(`[api] CORS: ${allowedOrigins ? allowedOrigins.join(', ') : 'all origins (dev)'}`);
});
