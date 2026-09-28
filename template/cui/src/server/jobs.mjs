import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import * as G from './git.mjs'
import { runClaude } from './claude.mjs'
import { run, get, all, json } from './db.mjs'

const MAX_CONCURRENT = 2
const MAX_INLINE_DIFF = 60_000

const queue = []
let active = 0

function pump() {
  while (active < MAX_CONCURRENT && queue.length) {
    const task = queue.shift()
    active++
    task().finally(() => { active--; pump() })
  }
}

const enqueue = (task) => { queue.push(task); pump() }

export const queueDepth = () => ({ queued: queue.length, running: active })

// ------------------------------------------------------------------ context

function commitContext(cfg, sha) {
  const root = cfg.root
  const meta = G.commitMeta(root, sha)
  const files = G.commitFiles(root, sha)
  const diff = G.diffText(root, sha)
  const truncated = diff.length > MAX_INLINE_DIFF
  return {
    meta,
    files,
    diff: truncated ? diff.slice(0, MAX_INLINE_DIFF) : diff,
    truncated,
  }
}

function fileList(files) {
  return files
    .map((f) => `  ${f.change} ${f.path}  (+${f.insertions} -${f.deletions})`)
    .join('\n')
}

function milestoneContext(db, sha) {
  const rows = all(db, `
    select cm.milestone_key, cm.impact, cm.note, cm.criteria_met, m.title, m.demo
    from commit_milestones cm left join milestones m on m.key = cm.milestone_key
    where cm.sha = ?`, [sha])
  if (!rows.length) return '  (none recorded)'
  return rows.map((r) => {
    const met = json(r.criteria_met, [])
    return `  ${r.milestone_key} — ${r.impact}${met.length ? ` (criteria met: ${met.join(', ')})` : ''}` +
      (r.title ? `\n    milestone: ${r.title}` : '')
  }).join('\n')
}

// ------------------------------------------------------------------ prompts

function walkthroughPrompt(db, cfg, sha) {
  const { meta, files, diff, truncated } = commitContext(cfg, sha)
  return `Write a code walkthrough of a single commit in this repository, for the CUI dashboard.

Follow the \`code-walkthrough\` skill if it is available to you. If it is not, write in the
style of a good engineering blog post: a clear narrative thread, real code snippets copied
verbatim from the repo, honest about trade-offs. The reader owns this codebase but did not
write this commit, and needs to end up able to maintain it.

## The commit

sha:     ${meta.sha}
short:   ${meta.short_sha}
author:  ${meta.author_name}
date:    ${meta.committed_at}
subject: ${meta.subject}

message body:
${meta.body || '(none)'}

files changed (${files.length}):
${fileList(files)}

Product Function milestones this commit was scored against:
${milestoneContext(db, sha)}

## Repository context

Read these before you start — they tell you the rules this code was written under:
- \`.cui/blueprint.yaml\` — the locked directory layout, boundary rules and entry points
- \`.cui/product-functions.yaml\` — the milestones the project is working toward
- \`ARCHITECTURE.md\` if it exists

Read the surrounding source files too, not only the diff. A walkthrough that cannot say who
calls the changed code is a walkthrough of a fragment. Use \`git show ${meta.sha}\` for the
full diff${truncated ? ' (it is truncated below, so you will need to)' : ''}, and
\`git show ${meta.sha}^:<path>\` to see the previous version of a file.

## The diff${truncated ? ' (truncated — read the rest with git)' : ''}

\`\`\`diff
${diff}
\`\`\`

## Output

Markdown only. Start with a \`# \` heading that names the problem, not the files. Do not wrap
your answer in a code fence. Do not preface it with "Here is". Precede every code snippet
with a \`// path/to/file.ext:LINE\` comment on its own line inside the fence — the dashboard
turns those into links. Include the "Design decisions", "What this doesn't do" and "Where to
look next" sections. Be as short as the commit deserves.`
}

function questionPrompt(db, cfg, sha, q) {
  const { meta, files, diff, truncated } = commitContext(cfg, sha)
  const wt = get(db, `select markdown from walkthroughs where sha = ? and status = 'ready'`, [sha])

  const location = q.file_path
    ? `The reader is looking at \`${q.file_path}\`${
        q.line_start ? ` lines ${q.line_start}${q.line_end && q.line_end !== q.line_start ? `–${q.line_end}` : ''}` : ''
      } as of commit ${meta.short_sha}.

Read it with: \`git show ${meta.sha}:${q.file_path}\`
${q.selection ? `\nThe exact text they selected:\n\`\`\`\n${q.selection}\n\`\`\`` : ''}`
    : `The question is about commit ${meta.short_sha} as a whole.`

  return `Answer a specific question about code in this repository.

Follow the \`code-walkthrough\` skill's "Answering questions" section if it is available.
Otherwise: answer the actual question in the first sentence, then ground the answer in the
real code — trace the actual call path, do not infer from names. Quote the relevant lines
with their real line numbers. Say plainly when you do not know rather than inventing a
rationale. If the question reveals a genuine bug, lead with that.

## Where they are

${location}

## The commit

sha:     ${meta.sha}
subject: ${meta.subject}
files:
${fileList(files)}

${wt?.markdown ? `## The walkthrough they have already read\n\n${wt.markdown.slice(0, 12_000)}\n` : ''}
## The diff${truncated ? ' (truncated — use git for the rest)' : ''}

\`\`\`diff
${diff}
\`\`\`

## The question

${q.question}

## Output

Markdown only, no preamble, no restating the question, no "great question". As short as the
question allows — a narrow question gets a paragraph and one snippet. Precede snippets with a
\`// path/to/file.ext:LINE\` comment inside the fence. Read whatever files you need first.`
}

/**
 * A walkthrough starts at its title. Models sometimes narrate what they just did first
 * ("I've read the diff, writing it up now") — useful in a terminal, noise in a document.
 */
function stripPreamble(text) {
  const idx = text.indexOf('\n# ')
  if (text.startsWith('# ')) return text
  // Only strip if the heading turns up early; otherwise trust the model's structure.
  if (idx > 0 && idx < 1200) return text.slice(idx + 1).trim()
  return text
}

// ------------------------------------------------------------------ jobs

export function startWalkthrough(db, cfg, sha, { force = false } = {}) {
  const existing = get(db, `select status from walkthroughs where sha = ?`, [sha])
  if (existing && !force && ['ready', 'running', 'pending'].includes(existing.status)) {
    return { status: existing.status, queued: false }
  }

  run(db, `insert into walkthroughs(sha, status, started_at, markdown, error)
           values(?, 'pending', ?, null, null)
           on conflict(sha) do update set status='pending', started_at=excluded.started_at,
             markdown=null, error=null, finished_at=null`,
    [sha, new Date().toISOString()])

  enqueue(async () => {
    run(db, `update walkthroughs set status='running' where sha = ?`, [sha])
    try {
      const { text, durationMs } = await runClaude(cfg, walkthroughPrompt(db, cfg, sha), {
        allowedTools: ['Read', 'Grep', 'Glob', 'Bash(git:*)'],
        maxTurns: 40,
      })
      const markdown = stripPreamble(text)
      run(db, `update walkthroughs set status='ready', markdown=?, duration_ms=?,
               finished_at=?, error=null where sha = ?`,
        [markdown, durationMs, new Date().toISOString(), sha])

      // Also drop it on disk so it is greppable and reviewable outside the dashboard.
      try {
        mkdirSync(cfg.walkthroughDir, { recursive: true })
        writeFileSync(join(cfg.walkthroughDir, `${sha.slice(0, 7)}.md`), markdown)
      } catch { /* the database copy is authoritative */ }
    } catch (err) {
      run(db, `update walkthroughs set status='error', error=?, finished_at=? where sha = ?`,
        [err.message, new Date().toISOString(), sha])
    }
  })

  return { status: 'pending', queued: true }
}

export function askQuestion(db, cfg, sha, payload) {
  const info = run(db, `insert into questions(sha, file_path, line_start, line_end, selection,
                          question, status, asked_at)
                        values(?,?,?,?,?,?,'pending',?)`,
    [sha, payload.file_path ?? null, payload.line_start ?? null, payload.line_end ?? null,
     payload.selection ?? null, payload.question, new Date().toISOString()])
  const id = Number(info.lastInsertRowid)

  enqueue(async () => {
    run(db, `update questions set status='running' where id = ?`, [id])
    const q = get(db, `select * from questions where id = ?`, [id])
    try {
      const { text, durationMs } = await runClaude(cfg, questionPrompt(db, cfg, sha, q), {
        allowedTools: ['Read', 'Grep', 'Glob', 'Bash(git:*)'],
        maxTurns: 30,
      })
      run(db, `update questions set status='ready', answer=?, duration_ms=?, answered_at=?,
               error=null where id = ?`,
        [text, durationMs, new Date().toISOString(), id])
    } catch (err) {
      run(db, `update questions set status='error', error=?, answered_at=? where id = ?`,
        [err.message, new Date().toISOString(), id])
    }
  })

  return { id, status: 'pending' }
}
