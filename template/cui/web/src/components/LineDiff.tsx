// A plain line diff (LCS), enough to review a proposed change to a YAML file.

type Op = { kind: ' ' | '+' | '-'; text: string }

export function diffLines(before: string, after: string): Op[] {
  const a = before.split('\n')
  const b = after.split('\n')
  const n = a.length
  const m = b.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  const out: Op[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ kind: ' ', text: a[i] }); i++; j++ }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ kind: '-', text: a[i++] })
    else out.push({ kind: '+', text: b[j++] })
  }
  while (i < n) out.push({ kind: '-', text: a[i++] })
  while (j < m) out.push({ kind: '+', text: b[j++] })
  return out
}

/** Changed lines with `context` lines around them; long unchanged runs collapse. */
export function LineDiff({ before, after, context = 3 }: { before: string; after: string; context?: number }) {
  const ops = diffLines(before, after)
  const keep = ops.map((_, idx) => ops.slice(Math.max(0, idx - context), idx + context + 1).some((o) => o.kind !== ' '))
  const rows: (Op | null)[] = []
  ops.forEach((o, idx) => {
    if (keep[idx]) rows.push(o)
    else if (rows[rows.length - 1] !== null) rows.push(null)
  })
  if (!ops.some((o) => o.kind !== ' ')) return <div className="faint small">No textual change.</div>
  return (
    <pre className="mono small" style={{ margin: 0, padding: 10, background: 'var(--bg-2)', borderRadius: 'var(--r)', overflowX: 'auto' }}>
      {rows.map((o, idx) => o === null
        ? <div key={idx} className="faint">⋯</div>
        : (
          <div key={idx} style={{
            color: o.kind === '+' ? 'var(--green)' : o.kind === '-' ? 'var(--red)' : 'var(--fg-dim)',
            background: o.kind === '+' ? '#0f2a16' : o.kind === '-' ? '#2d1210' : undefined,
          }}>{o.kind} {o.text}</div>
        ))}
    </pre>
  )
}
