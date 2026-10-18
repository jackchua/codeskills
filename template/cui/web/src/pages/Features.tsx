import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { useAsync, Spinner, ErrorBox, Stat, Empty, Badge, FeatureStateBadge, relTime } from '../components/ui'

const FILTERS = ['all', 'broken', 'passing', 'excepted', 'planned', 'retired'] as const
type Filter = typeof FILTERS[number]

const matches = (f: any, filter: Filter) =>
  filter === 'all' ? f.state !== 'retired'
    : filter === 'broken' ? f.state === 'failing' || f.state === 'untested'
      : f.state === filter

export function Features() {
  const { data, error, loading } = useAsync(() => api.registry(), [])
  const [filter, setFilter] = useState<Filter>('all')
  const [q, setQ] = useState('')

  const groups = useMemo(() => {
    if (!data) return []
    const needle = q.trim().toLowerCase()
    const rows = data.features.filter((f: any) => matches(f, filter) &&
      (!needle || `${f.id} ${f.title ?? ''}`.toLowerCase().includes(needle)))
    const by = new Map<string, any[]>()
    for (const f of rows) by.set(f.milestone ?? '(no milestone)', [...(by.get(f.milestone ?? '(no milestone)') ?? []), f])
    return [...by.entries()]
  }, [data, filter, q])

  if (loading) return <Spinner />
  if (error) return <ErrorBox error={error} />
  const { summary: s, errors, warnings, exceptions } = data

  if (!s.total) {
    return (
      <>
        <div className="page-head"><h1>Features</h1></div>
        <Empty>
          No feature registry yet. Run <code>/cui:features</code> in Claude Code — it turns each milestone's
          acceptance criteria into registered features, each with an ID and a test plan.
        </Empty>
      </>
    )
  }

  const broken = s.failing + s.untested

  return (
    <>
      <div className="page-head">
        <h1>Feature registry</h1>
        <p>
          Every feature has an ID and a test plan; tests carry the ID in their name. CI fails if an active
          feature has no passing test.
          {data.results_at && <span className="faint"> Results from {relTime(data.results_at)}.</span>}
        </p>
      </div>

      {errors.length > 0 && (
        <div className="banner bad">
          <b>Registry check fails — {errors.length} error(s).</b>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {errors.slice(0, 8).map((e: any, i: number) => (
              <li key={i} className="small">
                {e.id?.startsWith('FR-') ? <Link to={`/features/${e.id}`} className="mono">{e.id}</Link> : null} {e.message}
              </li>
            ))}
            {errors.length > 8 && <li className="small">…and {errors.length - 8} more (run <code>cui registry check</code>)</li>}
          </ul>
        </div>
      )}

      <div className="grid c4" style={{ marginBottom: 14 }}>
        <Stat label="Passing" value={s.passing} tone="green" sub={`of ${s.total - s.retired - s.planned} active`} />
        <Stat label="Broken" value={broken} tone={broken ? 'red' : undefined}
              sub={broken ? `${s.failing} failing, ${s.untested} untested` : 'none'} />
        <Stat label="Planned" value={s.planned} sub="registered, not built" />
        <Stat label="Exceptions" value={s.excepted} tone={s.exceptions_pending ? 'yellow' : undefined}
              sub={s.exceptions_pending ? `${s.exceptions_pending} awaiting approval` : `${s.tests_untagged} untagged test(s)`} />
      </div>

      <div className="row wrap" style={{ marginBottom: 12, gap: 6 }}>
        {FILTERS.map((f) => (
          <button key={f} className={`tab ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>{f}</button>
        ))}
        <span className="spacer" style={{ flex: 1 }} />
        <input type="search" placeholder="filter by id or title" value={q} onChange={(e) => setQ(e.target.value)}
               style={{ maxWidth: 240 }} />
      </div>

      {groups.length === 0 && <Empty>Nothing matches.</Empty>}
      {groups.map(([ms, rows]) => (
        <div className="card" key={ms} style={{ marginBottom: 14 }}>
          <h2>
            {ms.startsWith('PF-') ? <Link to={`/milestones/${ms}`} className="mono">{ms}</Link> : ms}
            <span className="faint small" style={{ marginLeft: 8 }}>{rows.length} feature(s)</span>
          </h2>
          <table>
            <tbody>
              {rows.map((f: any) => (
                <tr key={f.id}>
                  <td style={{ width: 1, whiteSpace: 'nowrap' }}>
                    <Link to={`/features/${f.id}`} className="mono small">{f.id}</Link>
                  </td>
                  <td>{f.title}</td>
                  <td style={{ width: 1, whiteSpace: 'nowrap' }} className="mono small tabular">
                    {f.status === 'active' ? `${f.passing}/${f.ran} tests` : ''}
                  </td>
                  <td style={{ width: 1, whiteSpace: 'nowrap' }} className="small faint">
                    {f.plan_cases} planned case(s)
                  </td>
                  <td style={{ width: 1, whiteSpace: 'nowrap' }} className="small mono">
                    {f.mutation && (
                      <span title="mutation score / threshold"
                            style={{ color: f.mutation.score == null ? 'var(--fg-faint)' : f.mutation.score >= f.mutation.threshold ? 'var(--green)' : 'var(--red)' }}>
                        mut {f.mutation.score ?? '–'}%
                      </span>
                    )}
                  </td>
                  <td style={{ width: 1, whiteSpace: 'nowrap' }}>
                    {f.exception && <Badge tone="yellow">{f.exception}</Badge>}{' '}
                    <FeatureStateBadge state={f.state} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      <div className="card" style={{ marginBottom: 14 }}>
        <h2>Exceptions registry</h2>
        <p className="small dim" style={{ marginTop: 0 }}>
          Features that are verified some other way than an automated test. Each one names how, who owns it, and
          when it expires. Only you can approve one.
        </p>
        {exceptions.length === 0 && <div className="faint small">None — everything is tested.</div>}
        <table>
          <tbody>
            {exceptions.map((e: any) => (
              <tr key={e.id}>
                <td className="mono small" style={{ width: 1, whiteSpace: 'nowrap' }}>{e.id}</td>
                <td style={{ width: 1, whiteSpace: 'nowrap' }}>
                  <Link to={`/features/${e.feature}`} className="mono small">{e.feature}</Link>
                </td>
                <td>
                  <div>{e.reason}</div>
                  <div className="small faint">verified by: {e.verification ?? '—'}{e.test ? ` · quarantines "${e.test}"` : ''}</div>
                </td>
                <td className="small" style={{ width: 1, whiteSpace: 'nowrap' }}>{e.category}</td>
                <td className="small mono" style={{ width: 1, whiteSpace: 'nowrap',
                    color: e.status === 'approved' && e.days_left != null && e.days_left <= 14 ? 'var(--yellow)' : undefined }}>
                  {e.expires ? (e.days_left != null && e.days_left >= 0 ? `expires in ${e.days_left}d` : `expired ${e.expires}`) : 'no expiry'}
                </td>
                <td style={{ width: 1, whiteSpace: 'nowrap' }}>
                  {e.status === 'proposed' ? <Link to="/approvals"><Badge tone="yellow">awaiting you</Badge></Link>
                    : e.status === 'rejected' ? <Badge>rejected</Badge>
                      : e.in_force ? <Badge tone="green">approved</Badge> : <Badge tone="red">expired</Badge>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {warnings.length > 0 && (
        <div className="card">
          <h2>Warnings</h2>
          {warnings.map((w: any, i: number) => <div key={i} className="small dim">{w.message}</div>)}
        </div>
      )}
    </>
  )
}
