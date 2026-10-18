import { Link } from 'react-router-dom'
import { api } from '../api'
import { useAsync, Stat, Spinner, ErrorBox, CoverageBar, StatusBadge, relTime, churn, Badge } from '../components/ui'
import { Sparkline } from '../components/Sparkline'

export function Overview() {
  const { data, error, loading } = useAsync(() => api.overview(), [])
  if (loading) return <Spinner />
  if (error) return <ErrorBox error={error} />
  const { meta, milestones, commits, trend, health, registry } = data
  const rs = registry?.summary

  const latest = trend.length ? trend[trend.length - 1] : null
  const active = milestones.filter((m: any) => m.status !== 'dropped')
  const criteriaMet = active.reduce((a: number, m: any) => a + m.criteria_met, 0)
  const criteriaTotal = active.reduce((a: number, m: any) => a + m.criteria_total, 0)

  return (
    <>
      <div className="page-head">
        <h1>{meta.product || 'This project'}</h1>
        <p>{meta.north_star || 'No north star recorded — add one to .cui/product-functions.yaml.'}</p>
      </div>

      {!health.blueprint_locked && (
        <div className="banner warn">
          <b>The repo blueprint is not locked.</b> Implementation writes are blocked until it is.
          Run <code>/blueprint</code> in Claude Code.
        </div>
      )}
      {health.milestones_total === 0 && (
        <div className="banner warn">
          <b>No Product Function milestones defined.</b> Nothing can be scored until they exist.
          Run <code>/pf</code>.
        </div>
      )}
      {health.approvals_pending > 0 && (
        <div className="banner warn">
          <b>{health.approvals_pending} item(s) are waiting on your approval</b> — proposed changes to the
          blueprint or registry, or exceptions. <Link to="/approvals">Review them →</Link>
        </div>
      )}
      {registry && !registry.ok && rs && (
        <div className="banner bad">
          <b>The feature registry check fails</b> ({registry.errors} error(s)) — CI will reject this tree.{' '}
          <Link to="/features">See which features →</Link>
        </div>
      )}
      {rs && rs.total === 0 && health.blueprint_locked && (
        <div className="banner warn">
          <b>No feature registry.</b> Run <code>/cui:features</code> so every feature gets an ID and a test plan.
        </div>
      )}
      {rs?.exceptions_expiring > 0 && (
        <div className="banner warn">
          <b>{rs.exceptions_expiring} exception(s) expire soon.</b> Test those features, or renew the exceptions
          before CI starts failing. <Link to="/features">See the exceptions registry →</Link>
        </div>
      )}
      {health.unexplained_test_changes > 0 && (
        <div className="banner warn">
          {health.unexplained_test_changes} commit(s) removed lines from existing tests without a{' '}
          <code>Test-Change:</code> trailer saying why. <Link to="/commits">Check the commits →</Link>
        </div>
      )}
      {health.unparsed_commits > 0 && (
        <div className="banner warn">
          {health.unparsed_commits} commit(s) landed without CUI trailers, so they are not scored
          against any milestone. Commit with <code>/ship</code> to keep the record complete.
        </div>
      )}
      {!health.coverage_file && health.commits_total > 0 && (
        <div className="banner warn">
          No coverage artifact found. Run your tests with coverage on so commits can be measured.
        </div>
      )}

      <div className="grid c4" style={{ marginBottom: 14 }}>
        <Stat
          label="Milestones"
          value={`${health.milestones_done}/${health.milestones_total}`}
          sub={`${criteriaMet}/${criteriaTotal} acceptance criteria met`}
          tone={health.milestones_done === health.milestones_total && health.milestones_total ? 'green' : undefined}
        />
        <Stat
          label="Project coverage"
          value={latest?.project_pct != null ? `${latest.project_pct}%` : '—'}
          sub={latest ? `as of ${latest.short_sha}` : 'no measurement yet'}
        />
        <Stat
          label="Features"
          value={rs?.total ? `${rs.passing}/${rs.total - rs.retired - rs.planned}` : '—'}
          tone={rs?.total ? (registry.ok ? 'green' : 'red') : undefined}
          sub={rs?.total ? `${rs.planned} planned · ${rs.excepted} excepted` : 'no registry yet'}
        />
        <Stat
          label="Demos owed"
          value={health.demos_owed}
          tone={health.demos_owed ? 'yellow' : 'green'}
          sub={health.demos_owed ? 'commits changed behaviour without proof' : 'every commit is accounted for'}
        />
      </div>

      <div className="grid c2" style={{ marginBottom: 14 }}>
        <div className="card">
          <h2>Coverage trend</h2>
          <Sparkline points={trend} />
        </div>
        <div className="card">
          <h2>Milestone progress</h2>
          {active.length === 0 && <div className="faint small">Nothing defined yet.</div>}
          {active.map((m: any) => (
            <Link key={m.key} to={`/milestones/${m.key}`}
                  style={{ display: 'block', color: 'inherit', marginBottom: 12 }}>
              <div className="spread" style={{ marginBottom: 4 }}>
                <span><b className="mono">{m.key}</b> <span className="dim">{m.title}</span></span>
                <StatusBadge status={m.status} />
              </div>
              <div className="bar">
                <i style={{ width: `${m.criteria_total ? (m.criteria_met / m.criteria_total) * 100 : 0}%` }} />
              </div>
              <div className="faint small mono" style={{ marginTop: 3 }}>
                {m.criteria_met}/{m.criteria_total} criteria · {m.commit_count} commit(s)
              </div>
            </Link>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="spread" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>Recent commits</h2>
          <Link to="/commits" className="small">all commits →</Link>
        </div>
        <div className="list">
          {commits.map((c: any) => (
            <Link key={c.sha} to={`/commits/${c.sha}`} className="commit-row">
              <div className="spread">
                <span className="subject">{c.subject}</span>
                <span className="row" style={{ gap: 8, flex: 'none' }}>
                  {c.demo_status === 'present' && <Badge tone="green">demo</Badge>}
                  {c.demo_status === 'waived' && <Badge>demo waived</Badge>}
                  {c.demo_status === 'missing' && c.demo_required === 1 && <Badge tone="yellow">no demo</Badge>}
                  {c.walkthrough_status === 'ready' && <Badge tone="purple">walkthrough</Badge>}
                  <CoverageBar pct={c.diff_pct} label="diff" />
                </span>
              </div>
              <div className="meta">
                {c.short_sha} · {c.author_name} · {relTime(c.committed_at)} · {churn(c.insertions, c.deletions)}
              </div>
            </Link>
          ))}
        </div>
      </div>
    </>
  )
}
