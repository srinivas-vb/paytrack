import { shortHash } from '../format.js'
import { ErrorBlock, LoadingBlock } from './Ui.jsx'

/**
 * Chain integrity, stated without overclaiming. Every entry carries the
 * fingerprint of the one before it, so a changed entry breaks everything after
 * it. That makes edits *evident*. It does not make them impossible.
 */
export default function IntegrityPanel({
  status,
  error,
  result,
  onRetry,
  workerId,
  workerIdPersisted,
}) {
  return (
    <>
      <section className="card">
        <h2>Record check</h2>

        {status === 'loading' ? (
          <LoadingBlock>Checking your record…</LoadingBlock>
        ) : null}

        {status === 'error' && !result ? (
          <ErrorBlock
            error={error}
            onRetry={onRetry}
            title="Could not check your record"
          />
        ) : null}

        {result ? (
          <>
            <div className={`status ${result.valid ? 'good' : 'bad'}`}>
              <strong>
                {result.valid
                  ? 'Your record checks out.'
                  : 'This record does not check out.'}
              </strong>
              <p>
                {result.valid
                  ? `All ${result.entryCount} ${result.entryCount === 1 ? 'entry links' : 'entries link'} to the one before it, unbroken.`
                  : 'One entry no longer matches the entry before it. Everything after that point is in question.'}
              </p>
              <dl>
                <dt>entries</dt>
                <dd>{result.entryCount ?? 0}</dd>
                <dt>latest fingerprint</dt>
                <dd title={result.latestHash || ''}>
                  {shortHash(result.latestHash, 16)}
                </dd>
                {!result.valid ? (
                  <>
                    <dt>breaks at</dt>
                    <dd>entry {result.brokenAt ?? 'unknown'}</dd>
                    <dt>reason</dt>
                    <dd>{result.reason || 'not reported'}</dd>
                  </>
                ) : null}
              </dl>
            </div>

            {!result.valid ? (
              <p className="hint">
                Save a screenshot of this and keep your earlier entries. A break
                is worth showing to whoever is helping you with your claim.
              </p>
            ) : null}

            <div className="button-row">
              <button
                type="button"
                className="btn"
                onClick={onRetry}
                disabled={status === 'refreshing'}
              >
                {status === 'refreshing' ? 'Checking…' : 'Check again'}
              </button>
            </div>

            {status === 'error' ? (
              <p className="hint">
                The last check failed, so this result may be stale.
              </p>
            ) : null}
          </>
        ) : null}
      </section>

      <section className="card muted">
        <h2>What this does and does not prove</h2>
        <p className="hint">
          Each entry carries a fingerprint of the entry before it. Change an old
          entry and every fingerprint after it stops matching — so tampering
          becomes <strong>evident</strong>. It is not tamper-<em>proof</em>: this
          is a record held by a third party that shows when it has been
          disturbed, not a vault.
        </p>
        <p className="hint">
          The times are what you reported; the server also stamps when it
          received each one, and shows the gap rather than hiding it. Location,
          where attached, is corroboration — it can be spoofed, and it gets its
          weight from being consistent across many entries, not from any single
          reading.
        </p>
      </section>

      <section className="card muted">
        <h2>This device</h2>
        <p className="hint">
          Your record is tied to this id, stored in this browser. There are no
          accounts or passwords in this prototype.
        </p>
        <p>
          <code className="worker-id">{workerId}</code>
        </p>
        {workerIdPersisted ? (
          <p className="hint">
            Clearing this browser&rsquo;s storage, or using a different device,
            means a different id and a different record. Write it down.
          </p>
        ) : (
          <p className="status warn">
            <strong>This id is not being saved.</strong>
            <span className="hint">
              {' '}
              Storage is blocked (private browsing, perhaps), so this record is
              lost when the tab closes. Write the id down or switch to a normal
              window.
            </span>
          </p>
        )}
      </section>
    </>
  )
}
