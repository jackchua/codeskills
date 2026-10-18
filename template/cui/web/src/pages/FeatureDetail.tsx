import { Link, useParams } from 'react-router-dom'
import { api } from '../api'
import { useAsync, Spinner, ErrorBox, Badge, StatusBadge, FeatureStateBadge, CoverageBar, relTime } from '../components/ui'

const TEST_TONE: Record<string, string> = { passed: 'green', failed: 'red', skipped: '', quarantined: 'yellow' }
const KIND_LABEL: Record<string, string> = {
  'red-green': 'red → green', extended: 'extended', fix: 'fix', refactor: 'refactor', other: 'touched',
}

export function FeatureDetail() {
  const { id } = useParams()
  const { data, error, loading } = useAsync(() => api.feature(id!), [id])
  if (loading) return <Spinner />
  if (error) return <ErrorBox error={error} />
  const { feature: f, errors, warnings, exceptions, milestone, tdd, commits, history, mutation } = data
  const cycles = tdd?.cycles ?? []

  return (
    <>
      <div className="page-head">
        <div className="row" style={{ marginBottom: 6 }}>
          <Link to="/features" className="small faint">← features</Link>
        </div>
        <h1><span className="mono dim">{f.id}</span> {f.title}</h1>
        <div className="row wrap" style={{ marginTop: 8, gap: 10 }}>
          <FeatureStateBadge state={f.state} />
          {f.status !== f.state && <Badge>{f.status}</Badge>}
          {f.risk === 'high' && <Badge tone="purple">high risk</Badge>}
          {milestone && (
            <span className="small faint">
              serves <Link to={`/milestones/${milestone.key}`} className="mono">{milestone.key}</Link> {milestone.title}{' '}
              <StatusBadge status={milestone.status} />
            </span>
          )}
          {f.criteria?.length > 0 && <span className="small mono faint">criteria {f.criteria.join(', ')}</span>}
        </div>
      </div>

      {errors.map((e: any, i: number) => <div key={i} className="banner bad">{e.message}</div>)}
      {warnings.map((w: any, i: number) => <div key={i} className="banner warn">{w.message}</div>)}

      <div className="grid c2" style={{ marginBottom: 14 }}>
        <div className="card">
          <h2>Test plan</h2>
          {(f.test_plan ?? []).length === 0 && <div className="faint small">No test plan — this feature cannot pass the check.</div>}
          <table>
            <tbody>
              {(f.test_plan ?? []).map((c: any, i: number) => (
                <tr key={i}>
                  <td style={{ width: 1, whiteSpace: 'nowrap' }}><Badge tone="blue">{c.level}</Badge></td>
                  <td>{c.case}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {f.notes && <p className="small dim">{f.notes}</p>}
        </div>

        <div className="card">
          <h2>Test-first evidence</h2>
          {cycles.length === 0 && (
            <div className="faint small">
              No red → green cycle recorded. Features built with <code>cui tdd red {f.id}</code> then{' '}
              <code>cui tdd green {f.id}</code> show here, proving the test failed before the code existed.
            </div>
          )}
          {cycles.map((c: any, i: number) => {
            const red = c.red.tests.filter((t: any) => t.status === 'failed')
            return (
              <div key={i} style={{ marginBottom: 10 }}>
                <div className="row" style={{ gap: 8 }}>
                  <span className="small faint">cycle {i + 1}</span>
                  <Badge tone="red">red · {red.length} failing</Badge>
                  <span className="faint">→</span>
                  {c.green ? <Badge tone="green">green · {c.green.tests.length} passing</Badge> : <Badge tone="yellow">not green yet</Badge>}
                  <span className="small faint">{relTime(c.green?.at ?? c.red.at)}</span>
                </div>
                <details style={{ marginTop: 4 }}>
                  <summary className="small dim">why each test failed first</summary>
                  {red.map((t: any) => (
                    <div key={t.name} className="small" style={{ marginTop: 4 }}>
                      <div>{t.name}</div>
                      <div className="mono faint">{t.message}</div>
                    </div>
                  ))}
                </details>
              </div>
            )
          })}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <h2>Tests tagged [{f.id}] <span className="faint small">{f.passing} passing · {f.failing} failing · from the latest local run</span></h2>
        {f.tests.length === 0 && <div className="faint small">No test carries this ID yet.</div>}
        <table>
          <tbody>
            {f.tests.map((t: any) => (
              <tr key={t.key}>
                <td style={{ width: 1, whiteSpace: 'nowrap' }}><Badge tone={TEST_TONE[t.status] ?? ''}>{t.status}</Badge></td>
                <td>
                  <div>{t.name}</div>
                  {t.message && <div className="small mono" style={{ color: 'var(--red)' }}>{t.message}</div>}
                </td>
                <td className="small faint mono" title={t.file ?? t.classname}
                    style={{ maxWidth: 280, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', direction: 'rtl', textAlign: 'left' }}>
                  {t.file ?? t.classname}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(f.risk === 'high' || mutation) && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h2>
            Mutation testing{' '}
            <span className="faint small">
              {(f.source ?? []).length ? `mutating ${f.source.join(', ')}` : 'no source: globs declared'}
            </span>
          </h2>
          {!mutation && (
            <div className="faint small">
              Never measured. Run <code>cui mutation --feature {f.id}</code>: it changes the code in small ways and
              checks the tests notice.
            </div>
          )}
          {mutation && (
            <>
              <div className="row" style={{ gap: 10, marginBottom: 8 }}>
                <Badge tone={mutation.passed ? 'green' : 'red'}>
                  {mutation.score ?? '–'}% · threshold {f.mutation?.threshold ?? mutation.threshold}%
                </Badge>
                <span className="small faint">
                  {mutation.killed} killed · {mutation.survived} survived · {mutation.no_coverage} uncovered ·{' '}
                  {relTime(mutation.at)}{mutation.head ? ` at ${mutation.head.slice(0, 7)}` : ''}
                </span>
              </div>
              {mutation.survivors.length > 0 && (
                <>
                  <div className="small dim" style={{ marginBottom: 4 }}>
                    Changes the tests did not notice. Each is a missing assertion:
                  </div>
                  <table>
                    <tbody>
                      {mutation.survivors.map((m: any, i: number) => (
                        <tr key={i}>
                          <td style={{ width: 1, whiteSpace: 'nowrap' }}>
                            <Badge tone={m.status === 'Survived' ? 'red' : 'yellow'}>{m.status === 'NoCoverage' ? 'uncovered' : 'survived'}</Badge>
                          </td>
                          <td className="mono small" style={{ whiteSpace: 'nowrap' }}>{m.file}:{m.line}</td>
                          <td className="small">{m.mutator}</td>
                          <td className="mono small faint">{m.replacement ? `→ ${String(m.replacement).slice(0, 60)}` : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </>
          )}
        </div>
      )}

      {exceptions.length > 0 && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h2>Exceptions</h2>
          {exceptions.map((e: any) => (
            <div key={e.id} style={{ marginBottom: 8 }}>
              <div className="row" style={{ gap: 8 }}>
                <span className="mono small">{e.id}</span>
                <Badge tone={e.status === 'proposed' ? 'yellow' : e.in_force ? 'green' : ''}>
                  {e.status === 'approved' && !e.in_force ? 'expired' : e.status}
                </Badge>
                <span className="small faint">{e.category} · expires {e.expires ?? 'never'} · owner {e.owner ?? '—'}</span>
              </div>
              <div className="small">{e.reason}</div>
              <div className="small dim">Verified instead by: {e.verification}</div>
            </div>
          ))}
        </div>
      )}

      {history.length > 1 && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h2>History</h2>
          <div className="row wrap" style={{ gap: 3 }}>
            {history.map((h: any) => (
              <span key={h.short_sha} title={`${h.short_sha}: ${h.state} (${h.passing} passing, ${h.failing} failing)`}
                    style={{ width: 10, height: 18, borderRadius: 2,
                             background: h.state === 'passing' ? 'var(--green)' : h.state === 'failing' || h.state === 'untested'
                               ? 'var(--red)' : 'var(--line-2)' }} />
            ))}
          </div>
          <div className="small faint" style={{ marginTop: 4 }}>one bar per commit, oldest first</div>
        </div>
      )}

      <div className="card">
        <h2>Commits</h2>
        {commits.length === 0 && <div className="faint small">No commit has declared a Feature: trailer for {f.id}.</div>}
        <div className="list">
          {commits.map((c: any) => (
            <Link key={c.sha} to={`/commits/${c.sha}`} className="commit-row">
              <div className="spread">
                <span className="subject">{c.subject}</span>
                <span className="row" style={{ gap: 8, flex: 'none' }}>
                  <Badge tone={c.kind === 'red-green' ? (c.verified ? 'green' : 'yellow') : ''}>
                    {KIND_LABEL[c.kind] ?? c.kind}{c.kind === 'red-green' && !c.verified ? ' (unverified)' : ''}
                  </Badge>
                  <CoverageBar pct={c.diff_pct} label="diff" />
                </span>
              </div>
              <div className="meta">{c.short_sha} · {c.author_name} · {relTime(c.committed_at)}{c.note ? ` · ${c.note}` : ''}</div>
            </Link>
          ))}
        </div>
      </div>
    </>
  )
}
