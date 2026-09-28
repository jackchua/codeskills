import { Link } from 'react-router-dom'
import { api } from '../api'
import { useAsync, Spinner, ErrorBox, StatusBadge, Empty } from '../components/ui'

export function Milestones() {
  const { data, error, loading } = useAsync(() => api.milestones(), [])
  if (loading) return <Spinner />
  if (error) return <ErrorBox error={error} />
  if (!data?.length) {
    return (
      <>
        <div className="page-head"><h1>Milestones</h1></div>
        <Empty>
          No Product Function milestones yet. Run <code>/pf</code> in Claude Code — it interviews
          you, drafts them, and will not write code until you approve the list.
        </Empty>
      </>
    )
  }

  return (
    <>
      <div className="page-head">
        <h1>Product Function milestones</h1>
        <p>Capabilities you can watch work. Every commit is scored against these.</p>
      </div>
      <div className="list">
        {data.map((m: any) => (
          <Link key={m.key} to={`/milestones/${m.key}`} className="ms-row">
            <div className="spread" style={{ marginBottom: 6 }}>
              <span><b className="mono">{m.key}</b>&nbsp; {m.title}</span>
              <StatusBadge status={m.status} />
            </div>
            <div className="bar" style={{ marginBottom: 6 }}>
              <i style={{ width: `${m.criteria_total ? (m.criteria_met / m.criteria_total) * 100 : 0}%` }} />
            </div>
            <div className="small faint">
              {m.criteria_met}/{m.criteria_total} criteria met
              {m.depends_on?.length ? ` · depends on ${m.depends_on.join(', ')}` : ''}
            </div>
            {m.demo && <div className="small dim" style={{ marginTop: 6 }}>Proof: {m.demo}</div>}
          </Link>
        ))}
      </div>
    </>
  )
}
