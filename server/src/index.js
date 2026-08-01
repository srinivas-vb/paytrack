import 'dotenv/config';
import express from 'express';
import cors from 'cors';

import { dbHealthy } from './db.js';
import { migrate } from './migrate.js';
import shiftsRouter from './routes/shifts.js';
import workplacesRouter from './routes/workplaces.js';
import paystubsRouter from './routes/paystubs.js';
import analysisRouter from './routes/analysis.js';

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
      // Deny by omitting the header, NOT by raising. Raising here turns a
      // routine policy decision into a 500, which buries real faults in the
      // logs and makes a blocked origin look like a broken server. The browser
      // enforces the block on its own once the header is absent.
      return callback(null, false);
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
// Routes. Each router applies requireWorker itself, so identity is enforced
// regardless of where it is mounted.
//
// Phase 3+ will add:
//   /api/explain     LLM legal explainer
// ---------------------------------------------------------------------------
app.use('/api/shifts', shiftsRouter);
app.use('/api/workplaces', workplacesRouter);
app.use('/api/paystubs', paystubsRouter);
app.use('/api/analysis', analysisRouter);

app.use((_req, res) => res.status(404).json({ error: 'not found' }));

app.use((err, _req, res, _next) => {
  // Respect err.status. express.json() raises a SyntaxError carrying
  // status 400 for malformed bodies; flattening that to 500 would report a
  // client mistake as a server fault and bury real faults in the logs.
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600
    ? err.status
    : 500;

  if (status >= 500) console.error('[api]', err);

  res.status(status).json({
    error: status === 400 && err.type === 'entity.parse.failed'
      ? 'malformed JSON body'
      : err.message || 'internal error',
  });
});

// Apply the schema before accepting traffic. Runs over Render's internal
// network in production, so the Postgres IP allow-list never comes into it.
await migrate();

app.listen(PORT, () => {
  console.log(`[api] listening on :${PORT}`);
  console.log(`[api] CORS: ${allowedOrigins ? allowedOrigins.join(', ') : 'all origins (dev)'}`);
});
