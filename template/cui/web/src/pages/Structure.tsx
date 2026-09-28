import { api } from '../api'
import { useAsync, Spinner, ErrorBox, Badge, Empty } from '../components/ui'

const KIND_TONE: Record<string, string> = { http: 'blue', cli: 'purple', worker: 'yellow', job: 'yellow', ui: 'green' }

export function Structure() {
  const { data, error, loading } = useAsync(() => api.structure(), [])
  if (loading) return <Spinner />
  if (error) return <ErrorBox error={error} />
  const { layout, entrypoints, stack, conventions, locked, locked_at } = data

  return (
    <>
      <div className="page-head">
        <h1>Structure</h1>
        <p>
          Decided before any code was written, and fixed since.
          Source of truth: <code>.cui/blueprint.yaml</code>.
        </p>
      </div>

      {locked
        ? <div className="banner" style={{ borderColor: '#1f6f32', background: '#0f2a16', color: 'var(--green)' }}>
            Blueprint locked{locked_at ? ` on ${locked_at}` : ''}. New top-level directories need an
            explicit amendment, recorded in the commit's <code>Blueprint:</code> trailer.
          </div>
        : <div className="banner warn">
            <b>Not locked.</b> Implementation writes are blocked. Run <code>/blueprint</code>.
          </div>}

      {(Object.keys(stack).length > 0 || Object.keys(conventions).length > 0) && (
        <div className="grid c2" style={{ marginBottom: 14 }}>
          {Object.keys(stack).length > 0 && (
            <div className="card">
              <h2>Stack</h2>
              <table><tbody>
                {Object.entries(stack).map(([k, v]) => (
                  <tr key={k}><td className="faint" style={{ width: 150 }}>{k}</td><td className="mono">{String(v)}</td></tr>
                ))}
              </tbody></table>
            </div>
          )}
          {Object.keys(conventions).length > 0 && (
            <div className="card">
              <h2>Conventions</h2>
              <table><tbody>
                {Object.entries(conventions).map(([k, v]) => (
                  <tr key={k}><td className="faint" style={{ width: 150 }}>{k}</td><td>{String(v)}</td></tr>
                ))}
              </tbody></table>
            </div>
          )}
        </div>
      )}

      <div className="card" style={{ marginBottom: 14 }}>
        <h2>Directory layout and boundaries</h2>
        {layout.length === 0 && <Empty>No layout recorded.</Empty>}
        <table>
          <thead>
            <tr><th>Path</th><th>Job</th><th>Owns</th><th>Must not</th><th>Serves</th></tr>
          </thead>
          <tbody>
            {layout.map((d: any) => (
              <tr key={d.path}>
                <td className="mono" style={{ whiteSpace: 'nowrap' }}>
                  {d.path}/
                  {!d.exists && <> <Badge tone="yellow">planned</Badge></>}
                </td>
                <td>{d.purpose}</td>
                <td className="small dim">{d.owns?.join(', ')}</td>
                <td className="small" style={{ color: 'var(--red)' }}>{d.forbidden?.join(', ') || '—'}</td>
                <td className="mono small faint">{d.serves?.join(' ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>Entry points</h2>
        <p className="small faint" style={{ marginTop: -6 }}>
          Every way a human or machine starts this system.
        </p>
        {entrypoints.length === 0 && <Empty>No entry points recorded.</Empty>}
        <table>
          <thead>
            <tr><th>Id</th><th>Kind</th><th>Command</th><th>File</th><th>What it does</th></tr>
          </thead>
          <tbody>
            {entrypoints.map((e: any) => (
              <tr key={e.id}>
                <td className="mono">{e.id}</td>
                <td><Badge tone={KIND_TONE[e.kind] ?? ''}>{e.kind}</Badge>{e.port && <> <span className="faint small mono">:{e.port}</span></>}</td>
                <td className="mono small">{e.command}</td>
                <td className="mono small faint" style={{ whiteSpace: 'nowrap' }}>
                  {e.path}{!e.exists && e.path && <> <Badge tone="yellow">planned</Badge></>}
                </td>
                <td className="small">{e.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
