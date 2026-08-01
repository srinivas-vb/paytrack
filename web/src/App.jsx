import { useCallback, useState } from 'react'
import './App.css'
import * as api from './api.js'
import { useResource } from './useResource.js'
import { getWorkerId, workerIdIsPersisted } from './workerId.js'
import ClockPanel from './components/ClockPanel.jsx'
import HistoryPanel from './components/HistoryPanel.jsx'
import WorkplacesPanel from './components/WorkplacesPanel.jsx'
import IntegrityPanel from './components/IntegrityPanel.jsx'
import PayPanel from './components/PayPanel.jsx'

const TABS = [
  { id: 'clock', label: 'Clock' },
  { id: 'history', label: 'History' },
  { id: 'pay', label: 'Pay' },
  { id: 'places', label: 'Places' },
  { id: 'record', label: 'Record' },
]

// Module-level so their identity is stable and useResource does not re-fetch
// on every render.
const loadShifts = () => api.listShifts(100)
const loadWorkplaces = () => api.listWorkplaces()
const loadVerification = () => api.verifyChain()
const loadPaystubs = () => api.listPaystubs()

export default function App() {
  const [tab, setTab] = useState('clock')
  const [retroOpen, setRetroOpen] = useState(false)
  const [workerId] = useState(getWorkerId)
  const [idPersisted] = useState(workerIdIsPersisted)

  const shifts = useResource(loadShifts)
  const workplaces = useResource(loadWorkplaces)
  const verification = useResource(loadVerification)
  const paystubs = useResource(loadPaystubs)

  const reloadShifts = shifts.reload
  const reloadVerification = verification.reload
  const reloadWorkplaces = workplaces.reload
  const reloadPaystubs = paystubs.reload

  // Anything that appends to the ledger changes both the shift list and the
  // chain, so they refresh together.
  const refreshLedger = useCallback(async () => {
    await Promise.all([reloadShifts(), reloadVerification()])
  }, [reloadShifts, reloadVerification])

  const openRetroForm = useCallback(() => {
    setRetroOpen(true)
    setTab('history')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [])

  return (
    <div className="app">
      <header className="app-header">
        <h1>PayTrack</h1>
        <p className="tagline">Your hours. Your record. Your evidence.</p>
      </header>

      <nav className="tabs" role="tablist" aria-label="Sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            className="tab"
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main
        className="shell"
        role="tabpanel"
        id={`panel-${tab}`}
        aria-labelledby={`tab-${tab}`}
      >
        {tab === 'clock' ? (
          <ClockPanel
            status={shifts.status}
            error={shifts.error}
            openShift={shifts.data?.openShift ?? null}
            onChanged={refreshLedger}
            onRetry={reloadShifts}
            onAddPastShift={openRetroForm}
          />
        ) : null}

        {tab === 'history' ? (
          <HistoryPanel
            status={shifts.status}
            error={shifts.error}
            shifts={shifts.data?.shifts ?? []}
            onRetry={reloadShifts}
            onChanged={refreshLedger}
            retroOpen={retroOpen}
            setRetroOpen={setRetroOpen}
          />
        ) : null}

        {tab === 'pay' ? (
          <PayPanel
            status={paystubs.status}
            error={paystubs.error}
            paystubs={paystubs.data ?? []}
            onRetry={reloadPaystubs}
            onChanged={reloadPaystubs}
          />
        ) : null}

        {tab === 'places' ? (
          <WorkplacesPanel
            status={workplaces.status}
            error={workplaces.error}
            workplaces={workplaces.data ?? []}
            onRetry={reloadWorkplaces}
            onChanged={reloadWorkplaces}
          />
        ) : null}

        {tab === 'record' ? (
          <IntegrityPanel
            status={verification.status}
            error={verification.error}
            result={verification.data}
            onRetry={reloadVerification}
            workerId={workerId}
            workerIdPersisted={idPersisted}
          />
        ) : null}

        <footer>
          Prototype. Not legal advice, and not a substitute for a lawyer or your
          state labor agency.
        </footer>
      </main>
    </div>
  )
}
