import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { useAsync, Spinner, ErrorBox, Badge, CoverageBar, relTime, churn, Empty } from '../components/ui'

export function Commits() {
  const [q, setQ] = useState('')
  const [debounced, setDebounced] = useState('')
  const { data, error, loading } = useAsync(() => api.commits(debounced, 200), [debounced])

  return (
    <>
      <div className="page-head">
        <h1>Commits</h1>
        <p>Every commit with its coverage, demo and milestone impact.</p>
      </div>

      <input
        type="search"
        placeholder="Filter by subject, body, author, sha or changed file path…"
        value={q}
        style={{ marginBottom: 16 }}
        onChange={(e) => {
          setQ(e.target.value)
          clearTimeout((window as any).__cq)
          ;(window as any).__cq = setTimeout(() => setDebounced(e.target.value), 200)
        }}
      />

      {loading && <Spinner />}
      {error && <ErrorBox error={error} />}
      {data && data.length === 0 && (
        <Empty>{debounced ? 'No commits match.' : 'No commits recorded yet. Run `cui backfill` to import existing history.'}</Empty>
      )}

      <div className="list">
        {data?.map((c: any) => {
          const milestones = (c.milestones ?? '').split(',').filter(Boolean)
          return (
            <Link key={c.sha} to={`/commits/${c.sha}`} className="commit-row">
              <div className="spread" style={{ marginBottom: 3 }}>
                <span className="subject">{c.subject}</span>
                <span className="row" style={{ gap: 8, flex: 'none' }}>
                  {c.unparsed === 1 && <Badge tone="yellow">unscored</Badge>}
                  {c.tests_status === 'failing' && <Badge tone="red">tests failing</Badge>}
                  {c.demo_status === 'present' && <Badge tone="green">demo</Badge>}
                  {c.demo_status === 'missing' && c.demo_required === 1 && <Badge tone="yellow">demo owed</Badge>}
                  {c.walkthrough_status === 'ready' && <Badge tone="purple">walkthrough</Badge>}
                </span>
              </div>
              <div className="spread">
                <span className="meta">
                  {c.short_sha} · {c.author_name} · {relTime(c.committed_at)} ·{' '}
                  {c.files_changed} files {churn(c.insertions, c.deletions)}
                  {milestones.length > 0 && (
                    <> · {milestones.map((m: string) => m.replace(':', ' ')).join(', ')}</>
                  )}
                </span>
                <span className="row" style={{ gap: 12, flex: 'none' }}>
                  <CoverageBar pct={c.diff_pct} label="diff" />
                  <CoverageBar pct={c.project_pct} label="project" />
                </span>
              </div>
            </Link>
          )
        })}
      </div>
    </>
  )
}
