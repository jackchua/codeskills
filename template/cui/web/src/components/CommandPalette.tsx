import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { Badge } from './ui'

const TYPE_TONE: Record<string, string> = {
  command: 'blue', entrypoint: 'purple', milestone: 'green', commit: '', directory: 'yellow',
}

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<any[]>([])
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()

  useEffect(() => { inputRef.current?.focus() }, [])

  useEffect(() => {
    if (!q.trim()) { setResults([]); return }
    let live = true
    const id = setTimeout(() => {
      api.search(q).then((r) => { if (live) { setResults(r); setSel(0) } }).catch(() => {})
    }, 110)
    return () => { live = false; clearTimeout(id) }
  }, [q])

  const go = (r: any) => { onClose(); navigate(r.href) }

  return (
    <div className="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label="Search">
        <input
          ref={inputRef}
          type="search"
          placeholder="Search commands, entry points, milestones, commits, directories…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose()
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, results.length - 1)) }
            if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)) }
            if (e.key === 'Enter' && results[sel]) { e.preventDefault(); go(results[sel]) }
          }}
        />
        <div className="palette-results">
          {q && !results.length && (
            <div style={{ padding: '18px 16px' }} className="faint small">No matches.</div>
          )}
          {!q && (
            <div style={{ padding: '18px 16px' }} className="faint small">
              Everything runnable in this repo is catalogued in <code>.cui/commands.yaml</code>.
              Type to find it.
            </div>
          )}
          {results.map((r, i) => (
            <a
              key={`${r.type}-${r.id}`}
              className={`palette-item ${i === sel ? 'sel' : ''}`}
              href={r.href}
              onClick={(e) => { e.preventDefault(); go(r) }}
              onMouseEnter={() => setSel(i)}
            >
              <Badge tone={TYPE_TONE[r.type]}>{r.type}</Badge>
              <span className="t">{r.title}</span>
              {r.badge && <Badge tone={r.badge === 'unsafe' ? 'red' : ''}>{r.badge}</Badge>}
              {r.subtitle && <span className="s">{r.subtitle}</span>}
            </a>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Cmd/Ctrl-K anywhere opens the palette. */
export function usePaletteHotkey(open: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); open() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
}
