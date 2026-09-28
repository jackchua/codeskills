import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const reload = useCallback(() => {
    let live = true
    setLoading(true)
    fn()
      .then((d) => { if (live) { setData(d); setError(null) } })
      .catch((e) => { if (live) setError(e.message) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, deps)

  useEffect(() => reload(), [reload])
  return { data, error, loading, reload }
}

/** Polls while `active` is true — used to follow Claude jobs to completion. */
export function usePoll(fn: () => void, ms: number, active: boolean) {
  useEffect(() => {
    if (!active) return
    const id = setInterval(fn, ms)
    return () => clearInterval(id)
  }, [active, ms, fn])
}

export const Spinner = () => <i className="spinner" aria-label="loading" />

export function Badge({ tone, children }: { tone?: string; children: ReactNode }) {
  return <span className={`badge ${tone ?? ''}`}>{children}</span>
}

const IMPACT_TONE: Record<string, string> = {
  enabled: 'green', progress: 'blue', groundwork: 'purple', none: '',
}
export const ImpactBadge = ({ impact }: { impact: string }) =>
  <Badge tone={IMPACT_TONE[impact] ?? ''}>{impact}</Badge>

const STATUS_TONE: Record<string, string> = {
  done: 'green', in_progress: 'yellow', not_started: '', dropped: 'red',
}
export const StatusBadge = ({ status }: { status: string }) =>
  <Badge tone={STATUS_TONE[status] ?? ''}>{(status ?? '').replace(/_/g, ' ')}</Badge>

export function CoverageBar({ pct, label }: { pct: number | null; label?: string }) {
  if (pct === null || pct === undefined) {
    return <span className="faint mono small">{label ? `${label} ` : ''}n/a</span>
  }
  const tone = pct >= 80 ? '' : pct >= 50 ? 'warn' : 'bad'
  return (
    <span className="row" style={{ gap: 7 }}>
      {label && <span className="faint small">{label}</span>}
      <span className="mono small tabular" style={{ minWidth: 42, textAlign: 'right' }}>{pct}%</span>
      <span className={`bar ${tone}`} style={{ width: 54, flex: 'none' }}>
        <i style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
      </span>
    </span>
  )
}

export function Stat({ label, value, sub, tone }: {
  label: string; value: ReactNode; sub?: ReactNode; tone?: string
}) {
  return (
    <div className="card stat">
      <div className="label">{label}</div>
      <div className="value" style={tone ? { color: `var(--${tone})` } : undefined}>{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  )
}

export const Empty = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>

export function ErrorBox({ error }: { error: string }) {
  return <div className="banner bad"><b>Error</b> — {error}</div>
}

export function relTime(iso?: string | null) {
  if (!iso) return ''
  const diff = (Date.now() - new Date(iso).getTime()) / 1000
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`
  return new Date(iso).toLocaleDateString()
}

export const churn = (ins: number, del: number) => (
  <span className="mono small">
    <span style={{ color: 'var(--green)' }}>+{ins}</span>{' '}
    <span style={{ color: 'var(--red)' }}>−{del}</span>
  </span>
)

export function CopyButton({ text, label = 'copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className="ghost"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 1200)
        })
      }}
    >
      {done ? 'copied' : label}
    </button>
  )
}
