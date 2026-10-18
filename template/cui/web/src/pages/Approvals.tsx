import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { useAsync, Spinner, ErrorBox, Badge, Empty, relTime } from '../components/ui'
import { LineDiff } from '../components/LineDiff'

const ALLOW_TEXT: Record<string, (a: any) => string> = {
  'feature-removed': (a) => `${a.id} removed`,
  'feature-retired': (a) => `${a.id} retired`,
  'feature-demoted': (a) => `${a.id} demoted to planned`,
  'plan-shrunk': (a) => `${a.id} test plan down to ${a.to}`,
  'tests-removed': (a) => `${a.id} down to ${a.to} test(s)`,
  'exception-approved': (a) => `${a.id} approved until ${a.expires || 'forever'}`,
  'blueprint-changed': () => 'blueprint changed',
}

function Decide({ id, onDone }: { id: string; onDone: () => void }) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const go = (decision: 'approve' | 'reject') => {
    setBusy(true); setErr(null)
    api.decide(id, decision, note || undefined)
      .then(onDone)
      .catch((e) => setErr(e.message))
      .finally(() => setBusy(false))
  }
  return (
    <div style={{ marginTop: 10 }}>
      <div className="row" style={{ gap: 8 }}>
        <input type="text" placeholder="note (optional)" value={note} onChange={(e) => setNote(e.target.value)} style={{ flex: 1 }} />
        <button disabled={busy} className="primary" onClick={() => go('approve')}>Approve</button>
        <button disabled={busy} className="ghost" onClick={() => go('reject')}>Reject</button>
      </div>
      {err && <div className="small" style={{ color: 'var(--red)', marginTop: 4 }}>{err}</div>}
    </div>
  )
}

export function Approvals() {
  const { data, error, loading, reload } = useAsync(() => api.approvals(), [])
  if (loading) return <Spinner />
  if (error) return <ErrorBox error={error} />
  const { proposals, exceptions, log } = data
  const nothing = !proposals.length && !exceptions.length

  return (
    <>
      <div className="page-head">
        <h1>Approvals</h1>
        <p>
          Claude can add obligations on its own: features, test cases, tests. Taking one away, changing the
          locked blueprint, or excusing a feature from testing waits here for you. Each decision is recorded in{' '}
          <code>.cui/approvals.log</code>, and CI checks every dropped obligation against it.
        </p>
      </div>

      {nothing && <div style={{ marginBottom: 14 }}><Empty>Nothing is waiting on you.</Empty></div>}

      {proposals.map((p: any) => (
        <div className="card" key={p.id} style={{ marginBottom: 14 }}>
          <div className="spread">
            <h2 style={{ margin: 0 }}>{p.title}</h2>
            <span className="mono small faint">{p.id}</span>
          </div>
          <div className="small faint" style={{ margin: '4px 0 8px' }}>
            {p.kind === 'file' ? <>replaces <code>{p.target}</code></> : <>lets <Link to={`/features/${p.feature}`} className="mono">{p.feature}</Link> drop to {p.min} tagged test(s)</>}
            {' · '}proposed {relTime(p.created_at)}
          </div>
          <p style={{ marginTop: 0 }}><b>Why:</b> {p.why}</p>
          {p.stale && (
            <div className="banner warn">
              <b>{p.target} changed after this was proposed.</b> Approving would overwrite those changes, so it is
              refused. Reject it and ask for a fresh proposal.
            </div>
          )}
          {p.kind === 'file' && <LineDiff before={p.current ?? ''} after={p.content ?? ''} />}
          <Decide id={p.id} onDone={reload} />
        </div>
      ))}

      {exceptions.map((e: any) => (
        <div className="card" key={e.id} style={{ marginBottom: 14 }}>
          <div className="spread">
            <h2 style={{ margin: 0 }}>
              Exception for <Link to={`/features/${e.feature}`} className="mono">{e.feature}</Link>
            </h2>
            <span className="mono small faint">{e.id}</span>
          </div>
          <div className="row wrap small" style={{ gap: 10, margin: '6px 0' }}>
            <Badge tone="yellow">{e.category}</Badge>
            <span className="faint">expires {String(e.expires ?? 'never')}</span>
            <span className="faint">owner {e.owner ?? '—'}</span>
            {e.test && <span className="faint">quarantines only "{e.test}"</span>}
          </div>
          <p style={{ margin: '6px 0' }}><b>Why it can't be tested automatically:</b> {e.reason}</p>
          <p style={{ margin: '6px 0' }}><b>Verified instead by:</b> {e.verification}</p>
          <Decide id={e.id} onDone={reload} />
        </div>
      ))}

      <div className="card">
        <h2>Decision log</h2>
        {log.length === 0 && <div className="faint small">No decisions yet.</div>}
        <table>
          <tbody>
            {log.map((l: any, i: number) => (
              <tr key={i}>
                <td style={{ width: 1, whiteSpace: 'nowrap' }}>
                  <Badge tone={l.decision === 'approved' ? 'green' : 'red'}>{l.decision}</Badge>
                </td>
                <td>
                  <div><span className="mono small">{l.subject}</span> {l.title}</div>
                  {l.allows?.length > 0 && (
                    <div className="small faint">allows: {l.allows.map((a: any) => (ALLOW_TEXT[a.kind] ?? (() => a.kind))(a)).join('; ')}</div>
                  )}
                  {l.note && <div className="small dim">“{l.note}”</div>}
                </td>
                <td className="small faint" style={{ width: 1, whiteSpace: 'nowrap' }}>{l.by} · {relTime(l.at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
