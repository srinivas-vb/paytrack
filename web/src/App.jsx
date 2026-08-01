import { useEffect, useState } from 'react'
import './App.css'

// In dev, vite.config.js proxies /api -> localhost:3001, so this stays empty.
// In production, set VITE_API_URL to the Render API URL.
const API = import.meta.env.VITE_API_URL || ''

export default function App() {
  const [status, setStatus] = useState({ state: 'loading' })

  useEffect(() => {
    const started = performance.now()
    fetch(`${API}/api/health`)
      .then(async (res) => {
        const body = await res.json()
        setStatus({
          state: res.ok ? 'ok' : 'degraded',
          body,
          ms: Math.round(performance.now() - started),
        })
      })
      .catch((err) =>
        setStatus({
          state: 'error',
          error: err.message,
          ms: Math.round(performance.now() - started),
        }),
      )
  }, [])

  return (
    <main className="shell">
      <header>
        <h1>PayTrack</h1>
        <p className="tagline">Your hours. Your record. Your evidence.</p>
      </header>

      <section className="card">
        <h2>Phase 0 — connectivity</h2>
        <StatusRow status={status} />
      </section>

      <section className="card muted">
        <h2>Next</h2>
        <ol>
          <li>Deploy the blueprint to Render; confirm Cron Jobs are available</li>
          <li>
            <code>npm run db:init</code> against the Render Postgres URL
          </li>
          <li>
            <code>npm run db:verify</code> — watch the ledger refuse an UPDATE
          </li>
          <li>Phase 1: clock in/out, hash chain, retroactive entry</li>
        </ol>
      </section>

      <footer>
        Prototype. Not legal advice, and not a substitute for a lawyer or your
        state labor agency.
      </footer>
    </main>
  )
}

function StatusRow({ status }) {
  if (status.state === 'loading') {
    return <p className="status loading">checking API…</p>
  }

  if (status.state === 'error') {
    return (
      <div className="status bad">
        <strong>API unreachable</strong>
        <p>{status.error}</p>
        <p className="hint">
          Is the server running? <code>npm run dev:server</code>
        </p>
      </div>
    )
  }

  const { body, ms, state } = status
  return (
    <div className={`status ${state === 'ok' ? 'good' : 'warn'}`}>
      <strong>
        API reachable <span className="dim">({ms}ms)</span>
      </strong>
      <dl>
        <dt>service</dt>
        <dd>{body.service}</dd>
        <dt>database</dt>
        <dd>{body.db ? 'connected' : 'not connected'}</dd>
        <dt>server time</dt>
        <dd>{body.time}</dd>
      </dl>
      {!body.db && (
        <p className="hint">
          Set <code>DATABASE_URL</code> in <code>.env</code>, then{' '}
          <code>npm run db:init</code>.
        </p>
      )}
    </div>
  )
}
