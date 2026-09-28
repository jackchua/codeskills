import { useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import hljs from 'highlight.js/lib/common'
import { CopyButton } from './ui'

export type CodeLocation = { file: string; line: number }

type Block =
  | { kind: 'prose'; text: string }
  | { kind: 'code'; lang: string; code: string; loc: CodeLocation | null }

// Snippets in walkthroughs open with a `// path/to/file.ts:34` marker. Lifting it out
// of the code and into the header is what makes a walkthrough clickable.
const MARKER = /^\s*(?:\/\/|#|--|;|<!--)\s*([\w@][\w./@+-]*\.[A-Za-z0-9]+):(\d+)\s*(?:-->)?\s*$/

/**
 * Splits markdown into prose and fenced-code blocks. react-markdown renders the prose;
 * we render code ourselves so each snippet gets a header, a copy button and a link into
 * the file at that commit.
 */
function splitBlocks(md: string): Block[] {
  const lines = md.split('\n')
  const blocks: Block[] = []
  let prose: string[] = []
  let i = 0

  const flush = () => {
    if (prose.length) blocks.push({ kind: 'prose', text: prose.join('\n') })
    prose = []
  }

  while (i < lines.length) {
    // Fences are often indented — inside a list item, for instance — so allow leading
    // whitespace and strip that same indent back off the body.
    const open = lines[i].match(/^(\s*)(```+)\s*([^\s`]*)\s*$/)
    if (!open) { prose.push(lines[i++]); continue }

    const [, indent, fence, lang] = open
    const closer = new RegExp(`^\\s*${fence}\\s*$`)
    let j = i + 1
    const body: string[] = []
    while (j < lines.length && !closer.test(lines[j])) body.push(lines[j++])
    if (j >= lines.length) { prose.push(lines[i++]); continue } // unterminated — treat as prose

    flush()
    const dedented = indent
      ? body.map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l.replace(/^\s+/, '')))
      : body
    let loc: CodeLocation | null = null
    const m = dedented[0]?.match(MARKER)
    if (m) { loc = { file: m[1], line: Number(m[2]) }; dedented.shift() }
    blocks.push({ kind: 'code', lang: lang || '', code: dedented.join('\n'), loc })
    i = j + 1
  }
  flush()
  return blocks
}

function highlight(code: string, lang: string) {
  try {
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value
    return hljs.highlightAuto(code).value
  } catch {
    return code.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!))
  }
}

function CodeBlock({ block, onAsk }: { block: Extract<Block, { kind: 'code' }>; onAsk?: (l: CodeLocation) => void }) {
  const html = useMemo(() => highlight(block.code, block.lang), [block.code, block.lang])
  const label = block.loc ? `${block.loc.file}:${block.loc.line}` : block.lang || 'code'
  return (
    <div>
      <div className="snippet-head">
        <span>{label}</span>
        <span className="row" style={{ gap: 0 }}>
          {block.loc && onAsk && (
            <button className="ghost" onClick={() => onAsk(block.loc!)}>ask about this</button>
          )}
          <CopyButton text={block.code} />
        </span>
      </div>
      <pre><code className="hljs" dangerouslySetInnerHTML={{ __html: html }} /></pre>
    </div>
  )
}

export function Markdown({ text, onAsk }: { text: string; onAsk?: (loc: CodeLocation) => void }) {
  const blocks = useMemo(() => splitBlocks(text ?? ''), [text])
  return (
    <div className="md">
      {blocks.map((b, i) =>
        b.kind === 'code'
          ? <CodeBlock key={i} block={b} onAsk={onAsk} />
          : <ReactMarkdown key={i} remarkPlugins={[remarkGfm]}>{b.text}</ReactMarkdown>,
      )}
    </div>
  )
}
