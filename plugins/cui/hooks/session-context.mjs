#!/usr/bin/env node
// SessionStart: tell Claude where this project stands, so it doesn't have to rediscover
// the milestones, the blueprint and the gate state every session.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
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

// Feature ids and statuses from .cui/features.yaml, same no-dependency approach.
function features(yaml) {
  const counts = { planned: 0, active: 0, retired: 0 }
  if (!yaml) return null
  let last = null
  for (const line of yaml.split('\n')) {
    if (/^\s*-\s+id:\s*["']?FR-/.test(line)) { last = 'planned'; counts.planned++ ; continue }
    const s = line.match(/^\s{2,6}status:\s*["']?(planned|active|retired)/)
    if (s && last) { counts[last]--; counts[s[1]]++; last = null }
  }
  return counts
}

function expiringExceptions(yaml, warnDays) {
  if (!yaml) return []
  const out = []
  const today = Date.now()
  for (const block of yaml.split(/\n(?=\s*-\s+id:)/)) {
    const id = block.match(/-\s+id:\s*["']?([\w.-]+)/)?.[1]
    const exp = block.match(/expires:\s*["']?(\d{4}-\d{2}-\d{2})/)?.[1]
    const approved = /status:\s*["']?approved/.test(block)
    if (id && exp && approved && (Date.parse(exp) - today) / 86400000 <= warnDays) out.push(`${id} (${exp})`)
  }
  return out
}

function pendingApprovals(cui) {
  let n = 0
  const ex = read(join(cui, 'exceptions.yaml')) ?? ''
  n += (ex.match(/^\s+status:\s*["']?proposed/gm) ?? []).length
  try {
    for (const f of readdirSync(join(cui, 'proposals'))) {
      if (/^status:\s*["']?pending/m.test(read(join(cui, 'proposals', f)) ?? '')) n++
    }
  } catch { /* no proposals dir */ }
  return n
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

  const fr = features(read(join(cui, 'features.yaml')))
  if (locked && !fr) {
    L.push('', 'FEATURE REGISTRY: missing. Run the feature-registry skill (/cui:features) before')
    L.push('implementing: every feature needs an ID and a test plan, and CI enforces it.')
  } else if (fr) {
    L.push('', `Feature registry: ${fr.active} active, ${fr.planned} planned, ${fr.retired} retired.`)
  }
  const warnDays = Number((read(join(cui, 'config.yaml')) ?? '').match(/^exception_warning_days:\s*(\d+)/m)?.[1] ?? 14)
  const soon = expiringExceptions(read(join(cui, 'exceptions.yaml')), warnDays)
  if (soon.length) L.push(`Exceptions expiring within ${warnDays} days: ${soon.join(', ')} — mention it; test the feature or ask for a renewal.`)
  const waiting = pendingApprovals(cui)
  if (waiting) L.push(`${waiting} item(s) are waiting on the user's approval — mention it: cui approvals.`)

  L.push(
    '',
    'Working agreements in this repo:',
    '  - Test first, per feature: cui tdd red FR-X (tests tagged [FR-X] must fail), implement,',
    '    cui tdd green FR-X. Use the feature-tdd skill. Never implement an unregistered feature.',
    '  - You may only ADD obligations: features, test-plan cases, tests, proposed exceptions.',
    '    Removing or weakening one, or changing the locked blueprint, is a proposal the user',
    '    approves (cui propose ...). Never edit approvals.log, registry-baseline.json or .cui/tdd/.',
    '  - Structure is fixed by .cui/blueprint.yaml. Read it before creating files.',
    '    New top-level directories need an approved blueprint proposal; the gate blocks them.',
    '  - Every runnable command belongs in .cui/commands.yaml so the CUI can index it.',
    '  - Commit via the ship-commit skill (/cui:ship), never a bare `git commit`:',
    '    tests + coverage, a demo decision, and PF scoring are part of committing.',
    '  - The CUI dashboard: npm --prefix cui start  →  http://localhost:4317',
    '</cui-project-state>',
  )

  emit(L.join('\n'))
}

main().catch(() => process.exit(0))
