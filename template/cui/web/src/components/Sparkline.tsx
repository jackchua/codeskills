type Point = { committed_at: string; project_pct: number | null; short_sha: string }

export function Sparkline({ points, height = 52 }: { points: Point[]; height?: number }) {
  const data = points.flatMap((p) =>
    p.project_pct === null ? [] : [{ ...p, project_pct: p.project_pct }])
  if (data.length < 2) {
    return <div className="faint small" style={{ padding: '14px 0' }}>
      Not enough coverage history yet — it appears once two commits have been measured.
    </div>
  }

  const w = 100
  const values = data.map((d) => d.project_pct)
  const min = Math.max(0, Math.min(...values) - 5)
  const max = Math.min(100, Math.max(...values) + 5)
  const span = max - min || 1
  const x = (i: number) => (i / (data.length - 1)) * w
  const y = (v: number) => height - ((v - min) / span) * height

  const line = data.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(2)},${y(d.project_pct).toFixed(2)}`).join(' ')
  const area = `${line} L${w},${height} L0,${height} Z`
  const last = data[data.length - 1]
  const first = data[0]
  const delta = last.project_pct - first.project_pct

  return (
    <div>
      <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none"
           style={{ width: '100%', height, display: 'block' }}>
        <path d={area} fill="rgba(63,185,80,.12)" />
        <path d={line} fill="none" stroke="var(--green)" strokeWidth="1.2"
              vectorEffect="non-scaling-stroke" />
        <circle cx={x(data.length - 1)} cy={y(last.project_pct)} r="1.8" fill="var(--green)" />
      </svg>
      <div className="spread small faint mono" style={{ marginTop: 6 }}>
        <span>{first.short_sha} · {first.project_pct}%</span>
        <span style={{ color: delta >= 0 ? 'var(--green)' : 'var(--red)' }}>
          {delta >= 0 ? '+' : ''}{delta.toFixed(1)} pts over {data.length} commits
        </span>
        <span>{last.short_sha} · {last.project_pct}%</span>
      </div>
    </div>
  )
}
