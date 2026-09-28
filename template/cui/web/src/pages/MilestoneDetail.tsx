import { Link, useParams } from 'react-router-dom'
import { api } from '../api'
import { useAsync, Spinner, ErrorBox, StatusBadge, ImpactBadge, Badge, CoverageBar, relTime } from '../components/ui'

export function MilestoneDetail() {
  const { key } = useParams()
  const { data, error, loading } = useAsync(() => api.milestone(key!), [key])
  if (loading) return <Spinner />
  if (error) return <ErrorBox error={error} />
  const { milestone: m, criteria, commits } = data

  const enabling = commits.find((c: any) => c.impact === 'enabled')

  return (
    <>
      <div className="page-head">
        <div className="row" style={{ marginBottom: 6 }}>
          <Link to="/milestones" className="small faint">← milestones</Link>
        </div>
        <h1><span className="mono dim">{m.key}</span> {m.title}</h1>
        <div className="row" style={{ marginTop: 8 }}>
          <StatusBadge status={m.status} />
          {m.depends_on?.length > 0 && (
            <span className="small faint">depends on {m.depends_on.join(', ')}</span>
          )}
        </div>
      </div>

      {m.why && <div className="card" style={{ marginBottom: 14 }}>
        <h2>Why</h2><p style={{ margin: 0 }}>{m.why}</p>
      </div>}

      <div className="grid c2" style={{ marginBottom: 14 }}>
        <div className="card">
          <h2>Acceptance criteria</h2>
          {criteria.length === 0 && <div className="faint small">None defined — this milestone cannot be closed.</div>}
          <table>
            <tbody>
              {criteria.map((c: any) => (
                <tr key={c.id}>
                  <td style={{ width: 1, whiteSpace: 'nowrap' }}>
                    <span style={{ color: c.status === 'met' ? 'var(--green)' : 'var(--fg-faint)' }}>
                      {c.status === 'met' ? '✓' : '○'}
                    </span>
                  </td>
                  <td className="mono small faint" style={{ width: 1, whiteSpace: 'nowrap' }}>{c.id}</td>
                  <td style={{ opacity: c.status === 'met' ? 1 : 0.75 }}>{c.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card">
          <h2>How it gets proved</h2>
          <p className="small" style={{ marginTop: 0 }}>{m.demo || <span className="faint">No demo described. Add a demo: line so there is a bar to clear.</span>}</p>
          {enabling ? (
            <div className="banner" style={{ borderColor: '#1f6f32', background: '#0f2a16', color: 'var(--green)', marginBottom: 0 }}>
              Marked <b>enabled</b> by <Link to={`/commits/${enabling.sha}`}>{enabling.short_sha}</Link>
              {enabling.demo_status === 'present' ? ' with a demo attached.' : ' — but no demo is attached, so this claim is unverified.'}
            </div>
          ) : (
            <div className="small faint">No commit has claimed this milestone as enabled yet.</div>
          )}
        </div>
      </div>

      <div className="card">
        <h2>Commits against this milestone</h2>
        {commits.length === 0 && <div className="faint small">Nothing yet.</div>}
        <div className="list">
          {commits.map((c: any) => (
            <Link key={c.sha} to={`/commits/${c.sha}`} className="commit-row">
              <div className="spread">
                <span className="subject">{c.subject}</span>
                <span className="row" style={{ gap: 8, flex: 'none' }}>
                  <ImpactBadge impact={c.impact} />
                  {c.demo_status === 'present' && <Badge tone="green">demo</Badge>}
                  <CoverageBar pct={c.diff_pct} label="diff" />
                </span>
              </div>
              <div className="meta">
                {c.short_sha} · {relTime(c.committed_at)}
                {c.criteria_met?.length ? ` · met ${c.criteria_met.join(', ')}` : ''}
              </div>
            </Link>
          ))}
        </div>
      </div>
    </>
  )
}
