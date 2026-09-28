import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { Markdown } from './Markdown'
import { Spinner, relTime, Empty } from './ui'

export type AskTarget = {
  file_path?: string
  line_start?: number
  line_end?: number
  selection?: string
} | null

const SUGGESTIONS = [
  'Why is it done this way rather than the obvious alternative?',
  'What breaks if I change this?',
  'Where is this called from?',
  'What is not covered by tests here, and does it matter?',
]

export function AskPanel({ sha, files, target, onTargetChange }: {
  sha: string
  files: string[]
  target: AskTarget
  onTargetChange: (t: AskTarget) => void
}) {
  const [questions, setQuestions] = useState<any[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    api.questions(sha).then(setQuestions).catch((e) => setError(e.message))
  }, [sha])

  useEffect(() => { load() }, [load])

  const pending = questions.some((q) => q.status === 'pending' || q.status === 'running')
  useEffect(() => {
    if (!pending) return
    const id = setInterval(load, 2000)
    return () => clearInterval(id)
  }, [pending, load])

  const submit = async () => {
    if (!text.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await api.ask(sha, { question: text.trim(), ...(target ?? {}) })
      setText('')
      load()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const locLabel = (q: any) =>
    q.file_path
      ? `${q.file_path}${q.line_start ? `:${q.line_start}${q.line_end && q.line_end !== q.line_start ? `-${q.line_end}` : ''}` : ''}`
      : 'whole commit'

  return (
    <div>
      {questions.length === 0 && (
        <Empty>
          Ask anything about this commit — a specific line, a design decision, a consequence.
          Claude Code reads the repo at this commit to answer.
        </Empty>
      )}

      {questions.map((q) => (
        <div className="qa" key={q.id}>
          <div className="q">{q.question}</div>
          <div className="loc">
            {locLabel(q)} · asked {relTime(q.asked_at)}
            {q.duration_ms ? ` · answered in ${Math.round(q.duration_ms / 1000)}s` : ''}
          </div>
          {q.status === 'ready' && <Markdown text={q.answer} />}
          {(q.status === 'pending' || q.status === 'running') && (
            <div className="dim small"><Spinner /> {q.status === 'running' ? 'reading the code…' : 'queued…'}</div>
          )}
          {q.status === 'error' && <div className="banner bad">{q.error}</div>}
        </div>
      ))}

      <div className="ask-bar">
        <div className="row wrap" style={{ marginBottom: 8 }}>
          <span className="faint small">About:</span>
          <select
            value={target?.file_path ?? ''}
            style={{ width: 'auto', flex: 1, minWidth: 180 }}
            onChange={(e) =>
              onTargetChange(e.target.value ? { file_path: e.target.value } : null)
            }
          >
            <option value="">the whole commit</option>
            {files.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
          {target?.line_start && (
            <span className="badge blue">
              line {target.line_start}
              {target.line_end && target.line_end !== target.line_start ? `–${target.line_end}` : ''}
            </span>
          )}
          {target && (
            <button className="ghost" onClick={() => onTargetChange(null)}>clear</button>
          )}
        </div>

        <textarea
          placeholder="Ask a question…  (⌘↵ to send)"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit() }
          }}
        />

        <div className="spread" style={{ marginTop: 8 }}>
          <div className="row wrap" style={{ gap: 6 }}>
            {SUGGESTIONS.map((s) => (
              <button key={s} className="ghost small" style={{ fontSize: 11.5 }}
                      onClick={() => setText(s)}>{s}</button>
            ))}
          </div>
          <button className="primary" onClick={submit} disabled={busy || !text.trim()}>
            {busy ? <Spinner /> : 'Ask'}
          </button>
        </div>

        {error && <div className="banner bad" style={{ marginTop: 10 }}>{error}</div>}
      </div>
    </div>
  )
}
