import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../api'
import { useAsync, Spinner, ErrorBox, Badge, CopyButton, Empty } from '../components/ui'

export function Commands() {
  const [params, setParams] = useSearchParams()
  const [q, setQ] = useState(params.get('q') ?? '')
  const { data, error, loading } = useAsync(() => api.commands(), [])

  useEffect(() => {
    const next = new URLSearchParams(params)
    q ? next.set('q', q) : next.delete('q')
    setParams(next, { replace: true })
  }, [q])

  const filtered = useMemo(() => {
    if (!data) return []
    const needle = q.trim().toLowerCase()
    if (!needle) return data
    return data.filter((c: any) =>
      [c.name, c.command, c.description, c.category, c.entrypoint, c.example]
        .filter(Boolean).some((v: string) => String(v).toLowerCase().includes(needle)) ||
      (c.args ?? []).some((a: any) => `${a.flag} ${a.description}`.toLowerCase().includes(needle)))
  }, [data, q])

  const byCategory = useMemo(() => {
    const groups = new Map<string, any[]>()
    for (const c of filtered) {
      if (!groups.has(c.category)) groups.set(c.category, [])
      groups.get(c.category)!.push(c)
    }
    return [...groups.entries()]
  }, [filtered])

  return (
    <>
      <div className="page-head">
        <h1>Commands</h1>
        <p>
          Everything runnable in this repo, catalogued in <code>.cui/commands.yaml</code>.
          An undiscoverable command is how a codebase becomes opaque.
        </p>
      </div>

      <input type="search" placeholder="Search commands, flags, descriptions…"
             value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 18 }} />

      {loading && <Spinner />}
      {error && <ErrorBox error={error} />}
      {data && data.length === 0 && (
        <Empty>
          Nothing catalogued yet. Run <code>/blueprint</code> — every runnable command belongs
          in <code>.cui/commands.yaml</code>.
        </Empty>
      )}
      {data && data.length > 0 && filtered.length === 0 && <Empty>No command matches “{q}”.</Empty>}

      {byCategory.map(([category, cmds]) => (
        <div key={category} style={{ marginBottom: 20 }}>
          <h2 style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '.06em',
                       color: 'var(--fg-faint)', margin: '0 0 8px' }}>{category}</h2>
          <div className="list">
            {cmds.map((c: any) => (
              <div key={c.name} style={{ padding: 14, background: 'var(--bg-1)' }}>
                <div className="spread" style={{ marginBottom: 5 }}>
                  <span className="row">
                    <b className="mono">{c.name}</b>
                    {!c.safe && <Badge tone="red">destructive</Badge>}
                  </span>
                  <CopyButton text={c.command} label="copy command" />
                </div>
                <div className="mono small" style={{ color: 'var(--accent)', marginBottom: 6 }}>
                  $ {c.command}
                </div>
                {c.description && <div className="small dim">{c.description}</div>}
                {c.args?.length > 0 && (
                  <table style={{ marginTop: 8 }}>
                    <tbody>
                      {c.args.map((a: any) => (
                        <tr key={a.flag}>
                          <td className="mono small" style={{ width: 170, color: 'var(--purple)' }}>{a.flag}</td>
                          <td className="small dim">{a.description}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <div className="row wrap small faint" style={{ marginTop: 8, gap: 16 }}>
                  {c.example && <span className="mono">e.g. {c.example}</span>}
                  {c.entrypoint && <span className="mono">→ {c.entrypoint}</span>}
                  {c.outputs && <span>{c.outputs}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  )
}
