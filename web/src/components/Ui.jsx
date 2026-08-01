import { describeError } from '../api.js'

/** Inline feedback after an action. Tone maps to the existing status colours. */
export function Notice({ tone = 'good', title, children, onDismiss }) {
  return (
    <div className={`status ${tone} notice`} role="status">
      <div className="notice-body">
        <strong>{title}</strong>
        {children ? <p>{children}</p> : null}
      </div>
      {onDismiss ? (
        <button
          type="button"
          className="notice-close"
          onClick={onDismiss}
          aria-label="Dismiss"
        >
          ×
        </button>
      ) : null}
    </div>
  )
}

export function LoadingBlock({ children = 'Loading…' }) {
  return (
    <p className="status loading" aria-live="polite">
      {children}
    </p>
  )
}

export function ErrorBlock({ error, onRetry, title = 'Could not load this' }) {
  return (
    <div className="status bad" role="alert">
      <strong>{title}</strong>
      <p>{describeError(error)}</p>
      {onRetry ? (
        <p className="notice-actions">
          <button type="button" className="btn btn-small" onClick={onRetry}>
            Try again
          </button>
        </p>
      ) : null}
    </div>
  )
}

export function EmptyBlock({ title, children }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children}
    </div>
  )
}

export function Badge({ tone = 'note', children, title }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  )
}
