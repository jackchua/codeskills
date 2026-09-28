import { useMemo } from 'react'
import hljs from 'highlight.js/lib/common'

export type LineRange = { start: number; end: number } | null

const LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  mjs: 'javascript', cjs: 'javascript', py: 'python', go: 'go', rs: 'rust',
  rb: 'ruby', java: 'java', kt: 'kotlin', swift: 'swift', sql: 'sql',
  sh: 'bash', bash: 'bash', yml: 'yaml', yaml: 'yaml', json: 'json',
  css: 'css', html: 'xml', md: 'markdown', php: 'php', cs: 'csharp',
}

export function CodeViewer({ path, content, added, selection, onSelectLine }: {
  path: string
  content: string
  added?: Set<number>
  selection: LineRange
  onSelectLine: (line: number, extend: boolean) => void
}) {
  const lines = useMemo(() => {
    const lang = LANG_BY_EXT[path.split('.').pop()?.toLowerCase() ?? ''] ?? ''
    let html: string
    try {
      html = lang && hljs.getLanguage(lang)
        ? hljs.highlight(content, { language: lang }).value
        : hljs.highlightAuto(content).value
    } catch {
      html = content.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!))
    }
    // highlight.js can leave spans open across newlines; close and reopen them per line
    // so each row is independently valid HTML.
    const out: string[] = []
    const open: string[] = []
    for (const line of html.split('\n')) {
      const prefix = open.join('')
      const re = /<span [^>]*>|<\/span>/g
      let m: RegExpExecArray | null
      while ((m = re.exec(line))) {
        if (m[0] === '</span>') open.pop()
        else open.push(m[0])
      }
      out.push(prefix + line + '</span>'.repeat(open.length))
    }
    return out
  }, [content, path])

  const inSel = (n: number) => selection && n >= selection.start && n <= selection.end

  return (
    <div className="code-view">
      <table>
        <tbody>
          {lines.map((html, idx) => {
            const n = idx + 1
            const cls = [inSel(n) ? 'sel' : '', added?.has(n) ? 'added' : ''].filter(Boolean).join(' ')
            return (
              <tr key={n} className={cls}>
                <td
                  className="ln"
                  onClick={(e) => onSelectLine(n, e.shiftKey)}
                  title="click to select, shift-click to extend"
                >
                  {n}
                </td>
                <td className="src hljs" dangerouslySetInnerHTML={{ __html: html || ' ' }} />
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
