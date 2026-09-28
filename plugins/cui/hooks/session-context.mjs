#!/usr/bin/env node
// SessionStart: tell Claude where this project stands, so it doesn't have to rediscover
// the milestones, the blueprint and the gate state every session.

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const quiet = () => process.exit(0)

const emit = (text) => {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text },
  }))
  process.exit(0)
}

const readStdin = async () => {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}

function findRoot(start) {
  let dir = resolve(start)
  for (;;) {
    if (existsSync(join(dir, '.cui'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

const read = (p) => { try { return readFileSync(p, 'utf8') } catch { return null } }

// Minimal milestone extraction — enough for a status line without a YAML dependency.
function milestones(yaml) {
  if (!yaml) return []
  const out = []
  const lines = yaml.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*-\s*key:\s*["']?([\w.-]+)["']?/)
    if (!m) continue
    const entry = { key: m[1], title: '', status: 'not_started', met: 0, total: 0 }
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s*-\s*key:/.test(lines[j])) break
      const t = lines[j].match(/^\s*title:\s*["']?(.+?)["']?\s*$/)
      if (t) entry.title = t[1]
      const s = lines[j].match(/^\s{2,}status:\s*["']?(\w+)["']?/)
      if (s && !/^\s{8,}/.test(lines[j])) entry.status = s[1]
      if (/^\s*-\s*id:\s*[\w.-]+/.test(lines[j])) entry.total++
      if (/^\s*status:\s*met\s*$/.test(lines[j])) entry.met++
    }
    out.push(entry)
  }
  return out
}

const main = async () => {
  let input
  try { input = JSON.parse(await readStdin()) } catch { quiet() }

  const root = findRoot(input?.cwd || process.cwd())
  if (!root) quiet()

  const cui = join(root, '.cui')
  const pf = read(join(cui, 'product-functions.yaml'))
  const bp = read(join(cui, 'blueprint.yaml'))
  const locked = bp && /^\s*locked:\s*true\s*$/m.test(bp)
  const ms = milestones(pf)

  const L = ['<cui-project-state>', 'This project is managed by the CUI workflow plugin.', '']

  if (!ms.length) {
    L.push('STATUS: No Product Function milestones defined.')
    L.push('Implementation writes are BLOCKED by a PreToolUse hook until')
    L.push('.cui/product-functions.yaml has approved milestones.')
    L.push('Next step: run the pf-milestones skill (/cui:pf) — interview the user first.')
  } else if (!locked) {
    L.push(`STATUS: ${ms.length} milestone(s) defined; repo blueprint NOT locked.`)
    L.push('Implementation writes are BLOCKED until .cui/blueprint.yaml has locked: true.')
    L.push('Next step: run the repo-blueprint skill (/cui:blueprint).')
  } else {
    const done = ms.filter((m) => m.status === 'done').length
    L.push(`STATUS: gates open. ${done}/${ms.length} milestones done, blueprint locked.`)
  }

  if (ms.length) {
    L.push('', 'Product Function milestones:')
    for (const m of ms) {
      const crit = m.total ? ` [${m.met}/${m.total} criteria]` : ''
      L.push(`  ${m.key} (${m.status})${crit} — ${m.title}`)
    }
  }

  L.push(
    '',
    'Working agreements in this repo:',
    '  - Structure is fixed by .cui/blueprint.yaml. Read it before creating files.',
    '    New top-level directories need a blueprint amendment, not a judgement call.',
    '  - Every runnable command belongs in .cui/commands.yaml so the CUI can index it.',
    '  - Commit via the ship-commit skill (/cui:ship), never a bare `git commit`:',
    '    tests + coverage, a demo decision, and PF scoring are part of committing.',
    '  - The CUI dashboard: npm --prefix cui start  →  http://localhost:4317',
    '</cui:status-project-state>',
  )

  emit(L.join('\n'))
}

main().catch(() => process.exit(0))
