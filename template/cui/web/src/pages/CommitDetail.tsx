import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, demoFileUrl } from '../api'
import {
  useAsync, Spinner, ErrorBox, Badge, CoverageBar, ImpactBadge, Empty, relTime, churn, CopyButton,
} from '../components/ui'
import { Markdown } from '../components/Markdown'
import { CodeViewer, type LineRange } from '../components/CodeViewer'
import { AskPanel, type AskTarget } from '../components/AskPanel'

type Tab = 'changes' | 'demo' | 'walkthrough' | 'ask'

export function CommitDetail() {
  const { sha } = useParams()
  const { data, error, loading } = useAsync(() => api.commit(sha!), [sha])
  const [tab, setTab] = useState<Tab>('changes')
  const [target, setTarget] = useState<AskTarget>(null)

  if (loading) return <Spinner />
  if (error) return <ErrorBox error={error} />
  const { commit, files, coverage, previous_coverage, milestones, demo, walkthrough, question_count } = data

  const delta = coverage?.project_pct != null && previous_coverage?.project_pct != null
    ? Math.round((coverage.project_pct - previous_coverage.project_pct) * 10) / 10
    : null

  const askAbout = (t: AskTarget) => { setTarget(t); setTab('ask') }

  return (
    <>
      <div className="page-head">
        <div className="row" style={{ marginBottom: 6 }}>
          <Link to="/commits" className="small faint">← commits</Link>
        </div>
        <h1>{commit.subject}</h1>
        <div className="row wrap" style={{ marginTop: 8, gap: 10 }}>
          <span className="mono small faint">{commit.short_sha}</span>
          <span className="small faint">{commit.author_name} · {relTime(commit.committed_at)}</span>
          <span>{churn(commit.insertions, commit.deletions)}</span>
          <span className="small faint">{commit.files_changed} files</span>
          {commit.branch && <Badge>{commit.branch}</Badge>}
          {commit.tests_status === 'failing' && <Badge tone="red">tests failing</Badge>}
          {commit.unparsed === 1 && <Badge tone="yellow">no CUI trailers</Badge>}
          <CopyButton text={commit.sha} label="copy sha" />
        </div>
      </div>

      <div className="grid c3" style={{ marginBottom: 18 }}>
        <div className="card">
          <h2>Coverage</h2>
          <div style={{ marginBottom: 8 }}>
            <CoverageBar pct={coverage?.diff_pct ?? null} label="this commit" />
            <div className="faint small mono" style={{ marginTop: 2 }}>
              {coverage?.diff_total
                ? `${coverage.diff_covered}/${coverage.diff_total} added lines executed by tests`
                : 'no executable lines added'}
            </div>
          </div>
          <div>
            <CoverageBar pct={coverage?.project_pct ?? null} label="project" />
            {delta !== null && (
              <div className="faint small mono" style={{ marginTop: 2 }}>
                <span style={{ color: delta >= 0 ? 'var(--green)' : 'var(--red)' }}>
                  {delta >= 0 ? '+' : ''}{delta} pts
                </span>{' '}vs parent
              </div>
            )}
          </div>
        </div>

        <div className="card">
          <h2>Milestone impact</h2>
          {milestones.length === 0 && <div className="faint small">Not scored against any milestone.</div>}
          {milestones.map((m: any) => (
            <div key={m.milestone_key} style={{ marginBottom: 8 }}>
              <div className="row">
                <ImpactBadge impact={m.impact} />
                {m.milestone_key !== '(none)'
                  ? <Link to={`/milestones/${m.milestone_key}`} className="mono small">{m.milestone_key}</Link>
                  : <span className="faint small">no milestone</span>}
              </div>
              {m.title && <div className="small dim" style={{ marginTop: 2 }}>{m.title}</div>}
              {m.criteria_met?.length > 0 && (
                <div className="small mono" style={{ color: 'var(--green)', marginTop: 2 }}>
                  ✓ {m.criteria_met.join(', ')}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="card">
          <h2>Proof</h2>
          {demo?.status === 'present' && (
            <>
              <Badge tone="green">demo attached</Badge>
              <div className="small dim" style={{ marginTop: 6 }}>
                {demo.artifacts?.length} artifacts in <code>{demo.dir}</code>
              </div>
              <button className="ghost" style={{ marginTop: 6, paddingLeft: 0 }}
                      onClick={() => setTab('demo')}>view the evidence →</button>
            </>
          )}
          {demo?.status === 'skipped' && (
            <>
              <Badge>no demo</Badge>
              <div className="small dim" style={{ marginTop: 6 }}>{demo.reason}</div>
            </>
          )}
          {(!demo || demo.status === 'missing') && (
            demo?.required
              ? <><Badge tone="yellow">demo owed</Badge>
                  <div className="small dim" style={{ marginTop: 6 }}>
                    This commit changed behaviour but carries no proof it works.
                  </div></>
              : <div className="faint small">No demo needed.</div>
          )}
        </div>
      </div>

      {commit.blueprint_note && commit.blueprint_note !== 'unchanged' && (
        <div className="banner warn">
          <b>Blueprint amended:</b> {commit.blueprint_note}
        </div>
      )}

      <div className="tabs">
        {([
          ['changes', `Changes (${files.length})`],
          ['demo', 'Demo'],
          ['walkthrough', 'Walkthrough'],
          ['ask', `Ask${question_count ? ` (${question_count})` : ''}`],
        ] as [Tab, string][]).map(([id, label]) => (
          <button key={id} className={`tab ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'changes' && <Changes commit={commit} files={files} sha={commit.sha} onAsk={askAbout} />}
      {tab === 'demo' && <DemoView demo={demo} />}
      {tab === 'walkthrough' && <WalkthroughView sha={commit.sha} initial={walkthrough} onAsk={askAbout} />}
      {tab === 'ask' && (
        <AskPanel sha={commit.sha} files={files.map((f: any) => f.path)}
                  target={target} onTargetChange={setTarget} />
      )}
    </>
  )
}

// ------------------------------------------------------------------ changes

function Changes({ commit, files, sha, onAsk }: any) {
  const [openFile, setOpenFile] = useState<string | null>(null)
  const [selection, setSelection] = useState<LineRange>(null)

  return (
    <>
      {commit.body && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h2>Why</h2>
          <div className="md" style={{ whiteSpace: 'pre-wrap' }}>
            {commit.body.split('\n').filter((l: string) =>
              !/^(PF|Coverage|Demo|Blueprint|Tests|Co-Authored-By):/i.test(l.trim())).join('\n').trim()}
          </div>
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Files</h2>
        <table>
          <thead>
            <tr>
              <th style={{ width: 24 }}></th><th>Path</th><th style={{ width: 90 }}>Churn</th>
              <th style={{ width: 150 }}>New lines tested</th><th style={{ width: 130 }}>File coverage</th>
            </tr>
          </thead>
          <tbody>
            {files.map((f: any) => (
              <tr key={f.path}>
                <td className="mono faint">{f.change}</td>
                <td>
                  <button className="ghost mono small" style={{ padding: 0, textAlign: 'left' }}
                          onClick={() => { setOpenFile(openFile === f.path ? null : f.path); setSelection(null) }}>
                    {f.path}
                  </button>
                </td>
                <td>{churn(f.insertions, f.deletions)}</td>
                <td>
                  {f.diff_total
                    ? <CoverageBar pct={f.diff_total ? Math.round((f.diff_covered / f.diff_total) * 1000) / 10 : null} />
                    : <span className="faint small">—</span>}
                </td>
                <td><CoverageBar pct={f.pct ?? null} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {openFile && (
        <FileView
          sha={sha}
          path={openFile}
          added={new Set<number>(files.find((f: any) => f.path === openFile)?.added_lines ?? [])}
          selection={selection}
          setSelection={setSelection}
          onAsk={onAsk}
        />
      )}
    </>
  )
}

function FileView({ sha, path, added, selection, setSelection, onAsk }: any) {
  const { data, error, loading } = useAsync(() => api.fileAt(sha, path), [sha, path])

  const selectLine = (line: number, extend: boolean) => {
    setSelection((prev: LineRange) =>
      extend && prev
        ? { start: Math.min(prev.start, line), end: Math.max(prev.end, line) }
        : { start: line, end: line })
  }

  const ask = () => {
    if (!selection || !data) return
    const lines = data.content.split('\n').slice(selection.start - 1, selection.end)
    onAsk({
      file_path: path,
      line_start: selection.start,
      line_end: selection.end,
      selection: lines.join('\n').slice(0, 4000),
    })
  }

  return (
    <div className="card">
      <div className="spread" style={{ marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>{path} <span className="faint">at {sha.slice(0, 7)}</span></h2>
        <div className="row">
          <span className="faint small">
            {selection
              ? `lines ${selection.start}${selection.end !== selection.start ? `–${selection.end}` : ''} selected`
              : 'click a line number · shift-click to extend'}
          </span>
          <button className="primary" disabled={!selection} onClick={ask}>Ask about this</button>
        </div>
      </div>
      {loading && <Spinner />}
      {error && <div className="banner bad">{error}</div>}
      {data && (
        <CodeViewer path={path} content={data.content} added={added}
                    selection={selection} onSelectLine={selectLine} />
      )}
      <div className="faint small" style={{ marginTop: 8 }}>
        Green rows are lines this commit added.
      </div>
    </div>
  )
}

// --------------------------------------------------------------------- demo

function DemoView({ demo }: any) {
  if (!demo || demo.status === 'missing') {
    return (
      <Empty>
        {demo?.required
          ? 'This commit changed behaviour but no demo was attached. Run `cui demo register --dir demos/…`, or record why one is not needed.'
          : 'No demo for this commit, and none was owed.'}
      </Empty>
    )
  }
  if (demo.status === 'skipped') {
    return (
      <div className="card">
        <h2>No demo — deliberately</h2>
        <p style={{ margin: 0 }}>{demo.reason}</p>
      </div>
    )
  }

  const artifacts = demo.artifacts ?? []
  const narrative = artifacts.find((a: any) => a.name === 'demo.md')
  const rest = artifacts.filter((a: any) => a.name !== 'demo.md')

  return (
    <>
      {narrative && <ArtifactView artifact={narrative} bare />}
      {rest.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2>Artifacts</h2>
          {rest.map((a: any) => <ArtifactView key={a.path} artifact={a} />)}
        </div>
      )}
    </>
  )
}

function ArtifactView({ artifact, bare }: { artifact: any; bare?: boolean }) {
  const [text, setText] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const textual = ['markdown', 'text', 'json', 'table', 'script'].includes(artifact.kind)

  useEffect(() => {
    if (!textual) return
    fetch(demoFileUrl(artifact.path))
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setText)
      .catch((e) => setErr(e.message))
  }, [artifact.path, textual])

  const kb = (artifact.bytes / 1024).toFixed(1)

  if (artifact.kind === 'image') {
    return (
      <figure style={{ margin: '0 0 18px' }}>
        <img src={demoFileUrl(artifact.path)} alt={artifact.name} style={{ maxWidth: '100%' }} />
        <figcaption className="faint small mono" style={{ marginTop: 5 }}>{artifact.name} · {kb} KB</figcaption>
      </figure>
    )
  }

  if (artifact.kind === 'video') {
    return (
      <figure style={{ margin: '0 0 18px' }}>
        <video controls src={demoFileUrl(artifact.path)} style={{ maxWidth: '100%', borderRadius: 6 }} />
        <figcaption className="faint small mono" style={{ marginTop: 5 }}>{artifact.name} · {kb} KB</figcaption>
      </figure>
    )
  }

  const body = err
    ? <div className="banner bad">{err}</div>
    : text === null
      ? <Spinner />
      : artifact.kind === 'markdown'
        ? <Markdown text={text} />
        : <pre style={{ margin: 0, maxHeight: 420, overflow: 'auto', background: 'var(--bg-2)',
                        border: '1px solid var(--line)', borderRadius: 6, padding: 13,
                        fontSize: 12.5, whiteSpace: 'pre-wrap' }}>{text}</pre>

  if (bare) return <div className="card">{body}</div>

  return (
    <div style={{ marginBottom: 18 }}>
      <div className="snippet-head">
        <span>{artifact.name} · {kb} KB</span>
        <a className="btn" style={{ fontSize: 11, padding: '2px 8px' }}
           href={demoFileUrl(artifact.path)} target="_blank" rel="noreferrer">open raw</a>
      </div>
      <div style={{ border: '1px solid var(--line)', borderTop: 'none',
                    borderRadius: '0 0 6px 6px', padding: 13 }}>
        {body}
      </div>
    </div>
  )
}

// -------------------------------------------------------------- walkthrough

function WalkthroughView({ sha, initial, onAsk }: any) {
  const [state, setState] = useState<any>(initial ?? { status: 'none' })
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(() => {
    api.walkthrough(sha).then(setState).catch(() => {})
  }, [sha])

  const pending = state.status === 'pending' || state.status === 'running'
  useEffect(() => {
    if (!pending) return
    const id = setInterval(refresh, 2000)
    return () => clearInterval(id)
  }, [pending, refresh])

  const generate = async (force = false) => {
    setBusy(true)
    try {
      await api.generateWalkthrough(sha, force)
      setState({ status: 'pending' })
      refresh()
    } finally {
      setBusy(false)
    }
  }

  if (state.status === 'ready') {
    return (
      <>
        <div className="spread" style={{ marginBottom: 14 }}>
          <span className="faint small">
            Generated {relTime(state.finished_at)}
            {state.duration_ms ? ` in ${Math.round(state.duration_ms / 1000)}s` : ''}
            {' '}· click <b>ask about this</b> on any snippet to dig in
          </span>
          <button onClick={() => generate(true)} disabled={busy}>regenerate</button>
        </div>
        <div className="card"><Markdown text={state.markdown} onAsk={(loc) =>
          onAsk({ file_path: loc.file, line_start: loc.line, line_end: loc.line })} /></div>
      </>
    )
  }

  if (pending) {
    return (
      <div className="empty">
        <Spinner />{' '}
        {state.status === 'running'
          ? 'Claude Code is reading the commit and the surrounding files…'
          : 'Queued…'}
        <div className="faint small" style={{ marginTop: 8 }}>
          This usually takes 30–90 seconds. You can leave the page; it keeps running.
        </div>
      </div>
    )
  }

  return (
    <div className="empty">
      {state.status === 'error' && (
        <div className="banner bad" style={{ textAlign: 'left' }}>{state.error}</div>
      )}
      <p style={{ marginTop: 0 }}>
        No walkthrough yet. Generating one runs Claude Code headless against this repo — it reads
        the commit, the files around it and the blueprint, then writes it up like an engineering
        blog post.
      </p>
      <button className="primary" onClick={() => generate(false)} disabled={busy}>
        {busy ? <Spinner /> : 'Generate walkthrough'}
      </button>
    </div>
  )
}
