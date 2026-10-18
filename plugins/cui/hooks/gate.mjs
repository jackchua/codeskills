#!/usr/bin/env node
// PreToolUse gate: refuse implementation writes until PF milestones are approved and the
// repo blueprint is locked, and — for the life of the project — refuse any write that drops
// an obligation: deleting or demoting a registered feature, self-approving an exception,
// editing the locked blueprint, or touching the files only the cui tool and humans write.
// Opt-in per project — a repo without a .cui/ directory is never gated, so installing this
// plugin globally is safe.

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve, relative, sep } from 'node:path'

const allow = () => process.exit(0)

const deny = (reason) => {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }))
  process.exit(0)
}

const PROPOSE = `Write a proposal instead: \`node cui/bin/cui.mjs propose file --target <file> --from <draft> ` +
  `--title "..." --why "..."\` (or \`propose tests\` to drop tests), then ask the user to approve it ` +
  `with \`cui approve <id>\` or on the CUI Approvals page. Do not try another route to the same edit.`

const readStdin = async () => {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}

// Paths that are always writable, even while the gate is closed: the planning artifacts
// themselves, docs, the CUI app, and demo output.
const ALWAYS_ALLOWED = [
  /^\.cui([/\\]|$)/,
  /^cui([/\\]|$)/,
  /^demos([/\\]|$)/,
  /^\.claude([/\\]|$)/,
  /\.mdx?$/i,
  /^\.gitignore$/,
  /^\.gitattributes$/,
  /^\.env\.example$/,
  /^LICENSE$/i,
]

function findProjectRoot(start) {
  let dir = resolve(start)
  for (;;) {
    if (existsSync(join(dir, '.cui')) || existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function read(path) {
  try { return readFileSync(path, 'utf8') } catch { return null }
}

// Written only by the cui CLI (on a human's behalf) — never directly by the agent.
const TOOL_OWNED = [
  /^\.cui\/approvals\.log$/,
  /^\.cui\/registry-baseline\.json$/,
  /^\.cui\/tdd\//,
  /^\.cui\/mutation\//,
]
// The enforcement itself. The agent does not get to edit what checks the agent.
const ENFORCEMENT = [/^\.github\/workflows\/cui(-nightly)?\.ya?ml$/, /^\.github\/CODEOWNERS$/, /^CODEOWNERS$/]

/** The file as it would be after this tool call, or null if we can't tell. */
function afterContent(input, current) {
  const t = input.tool_input ?? {}
  if (input.tool_name === 'Write') return t.content ?? ''
  if (input.tool_name === 'Edit') {
    if (current === null || !current.includes(t.old_string ?? '')) return null
    return t.replace_all ? current.split(t.old_string).join(t.new_string) : current.replace(t.old_string, () => t.new_string)
  }
  if (input.tool_name === 'MultiEdit') {
    let out = current
    for (const e of t.edits ?? []) {
      if (out === null || !out.includes(e.old_string)) return null
      out = e.replace_all ? out.split(e.old_string).join(e.new_string) : out.replace(e.old_string, () => e.new_string)
    }
    return out
  }
  return null
}

// Just enough YAML reading to compare list entries without a dependency: splits a
// top-level list into `- id: X` blocks and pulls scalar fields out of each.
function entries(yaml, listKey) {
  const out = new Map()
  if (!yaml) return out
  const start = yaml.search(new RegExp(`^${listKey}:\\s*$`, 'm'))
  if (start === -1) return out
  const lines = yaml.slice(start).split('\n').slice(1)
  let cur = null
  let inPlan = false
  let inSource = false
  for (const line of lines) {
    if (/^\S/.test(line) && line.trim()) break // next top-level key
    const id = line.match(/^\s*-\s+id:\s*["']?([\w.-]+)["']?/)
    if (id && (!cur || line.search(/\S/) <= cur.indent)) {
      cur = { id: id[1], indent: line.search(/\S/), status: null, expires: null, risk: null, mutation_threshold: null, cases: 0, source: [] }
      out.set(cur.id, cur)
      inPlan = false
      inSource = false
      continue
    }
    if (!cur) continue
    const depth = line.search(/\S/)
    const field = line.match(/^\s+(status|expires|risk|mutation_threshold):\s*["']?([^"'#\s]+)/)
    if (field && depth <= cur.indent + 2) cur[field[1]] = field[2]
    const inline = line.match(/^\s+source:\s*\[(.*)\]/)
    if (inline && depth <= cur.indent + 2) { cur.source = inline[1].split(',').map(unquote).filter(Boolean); continue }
    if (/^\s+source:\s*$/.test(line) && depth <= cur.indent + 2) { inSource = true; inPlan = false; continue }
    if (/^\s+test_plan:\s*$/.test(line)) { inPlan = true; inSource = false; continue }
    const item = line.match(/^\s+-\s+(.*)$/)
    if (item && depth > cur.indent + 2 && inSource) { cur.source.push(unquote(item[1])); continue }
    if (inPlan && item && depth > cur.indent + 2) cur.cases++
    else if (/^\s+\w[\w-]*:/.test(line) && depth <= cur.indent + 2) { inPlan = false; inSource = false }
  }
  return out
}

const unquote = (v) => v.trim().replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '')

/** Why this edit to the feature registry drops an obligation, or null if it doesn't. */
function featuresViolation(before, after) {
  const a = entries(before, 'features')
  const b = entries(after, 'features')
  for (const [id, f] of a) {
    const g = b.get(id)
    if (!g) return `it removes ${id} from the registry`
    if (g.status === 'retired' && f.status !== 'retired') return `it retires ${id}`
    if (f.status === 'active' && g.status !== 'active' && g.status !== 'retired') return `it demotes ${id} from active`
    if (g.cases < f.cases) return `it shrinks ${id}'s test plan from ${f.cases} to ${g.cases} case(s)`
    if (g.status === 'retired') continue
    if (f.risk === 'high' && g.risk !== 'high') return `it lowers ${id} from risk: high, which exempts it from mutation testing`
    if (f.mutation_threshold !== null && !(Number(g.mutation_threshold) >= Number(f.mutation_threshold))) {
      return `it lowers ${id}'s mutation threshold from ${f.mutation_threshold}`
    }
    const dropped = f.source.filter((x) => !g.source.includes(x))
    if (dropped.length) return `it removes ${dropped.join(', ')} from ${id}'s source, hiding it from mutation testing`
  }
  return null
}

function exceptionsViolation(before, after) {
  const a = entries(before, 'exceptions')
  for (const [id, e] of entries(after, 'exceptions')) {
    const was = a.get(id)
    if (e.status === 'approved' && was?.status !== 'approved') {
      return `it marks ${id} approved — exceptions are approved by the user (cui approve ${id}), never by you. Leave it as status: proposed`
    }
    if (e.status === 'approved' && was && was.expires !== e.expires) {
      return `it changes the expiry of approved exception ${id}. Set it back to status: proposed with the new date so the user can re-approve`
    }
  }
  return null
}

function protectedFileDecision(relPosix, input, root) {
  if (TOOL_OWNED.some((re) => re.test(relPosix))) {
    deny(`Blocked writing ${relPosix}: this file is written only by the cui CLI ` +
      `(cui registry check --record, cui tdd, cui mutation, cui approve). Editing it by hand would forge the record.`)
  }
  if (ENFORCEMENT.some((re) => re.test(relPosix)) && existsSync(join(root, relPosix))) {
    deny(`Blocked writing ${relPosix}: it is part of what enforces the registry. ` +
      `Tell the user what you want changed and why; they edit it.`)
  }
  const current = read(join(root, relPosix))
  if (relPosix === '.cui/blueprint.yaml' && current && /^\s*locked:\s*true\s*$/m.test(current)) {
    deny(`Blocked writing .cui/blueprint.yaml: the blueprint is locked, and changing it needs the user's approval.\n\n${PROPOSE}`)
  }
  if (relPosix === '.cui/features.yaml' && current) {
    const after = afterContent(input, current)
    const why = after === null ? null : featuresViolation(current, after)
    if (why) deny(`Blocked writing .cui/features.yaml: ${why}. You may add features, add test-plan cases and ` +
      `promote planned → active; dropping an obligation needs the user's approval.\n\n${PROPOSE}`)
  }
  if (relPosix === '.cui/exceptions.yaml') {
    const after = afterContent(input, current)
    const why = after === null ? null : exceptionsViolation(current ?? '', after)
    if (why) deny(`Blocked writing .cui/exceptions.yaml: ${why}.`)
  }
}

// ---------------------------------------------------------------------- Bash

const PROTECTED_IN_SHELL = /(\.cui\/approvals\.log|\.cui\/registry-baseline\.json|\.cui\/tdd\b|\.cui\/mutation\b|\.cui\/features\.yaml|\.cui\/exceptions\.yaml|\.cui\/blueprint\.yaml|workflows\/cui(-nightly)?\.ya?ml|CODEOWNERS)/
// Commands that modify whatever path they are given, wherever it appears.
const MODIFIES_ANY_ARG = /\bsed\s+(-[a-zA-Z]*i|--in-place)|\bperl\s+-[a-zA-Z]*i|\b(mv|rm|truncate|dd)\s|\bgit\s+(checkout|restore|rm|mv|apply)\b|writeFile|appendFile|open\([^)]*['"][wa]/
// Commands that modify only their destination: the redirect target, tee's file, cp's last argument.
const destinations = (segment) => [
  ...[...segment.matchAll(/>>?\s*([^\s;&|]+)/g)].map((m) => m[1]),
  ...[...segment.matchAll(/\btee\s+(?:-a\s+)?([^\s;&|]+)/g)].map((m) => m[1]),
  ...(/\b(cp|install|ln)\s/.test(segment) ? [segment.trim().split(/\s+/).at(-1)] : []),
]

/**
 * Best effort: the shell can do anything, so this only stops the obvious routes around the
 * Write/Edit gate. CI plus CODEOWNERS review is the backstop; this keeps honest sessions honest.
 */
function bashDecision(command) {
  if (/cui(\.mjs)?["']?\s+(approve|reject)\b|cui(\.mjs)?["']?\s+ratchet\s+accept\b/.test(command)) {
    deny('Blocked: approving, rejecting and accepting ratchet changes are the user\'s decisions. ' +
      'Show them what is pending (cui approvals) and ask them to run it themselves, e.g. `! node cui/bin/cui.mjs approve <id>`, ' +
      'or to use the CUI Approvals page.')
  }
  if (/\/api\/approvals/.test(command)) {
    deny('Blocked: the CUI approvals endpoint is for the user, not for you.')
  }
  for (const segment of command.split(/&&|\|\||;|\||\n/)) {
    const target = segment.match(PROTECTED_IN_SHELL)
    if (!target) continue
    const writes = MODIFIES_ANY_ARG.test(segment) || destinations(segment).some((d) => PROTECTED_IN_SHELL.test(d))
    if (!writes) continue // reading is fine
    deny(`Blocked: this command writes to ${target[0]} from the shell, which bypasses the checks on that file. ` +
      `Use the Edit or Write tool (the gate will tell you if the change needs approval), or the cui CLI.`)
  }
}

/** First path segment of every layout and entry point path in the blueprint. */
function blueprintTopLevels(bp) {
  const out = new Set()
  for (const m of (bp ?? '').matchAll(/^\s*-?\s*path:\s*["']?([^"'\s#]+)/gm)) {
    out.add(m[1].replace(/^\.\//, '').split('/')[0])
  }
  return out
}

const main = async () => {
  let input
  try { input = JSON.parse(await readStdin()) } catch { allow() }

  const root = findProjectRoot(input?.cwd || process.cwd())
  if (!root) allow()

  const cuiDir = join(root, '.cui')
  if (!existsSync(cuiDir)) allow() // not a CUI-managed project

  const config = read(join(cuiDir, 'config.yaml')) ?? ''
  if (/^\s*enforce:\s*false\s*$/m.test(config)) allow()

  if (input.tool_name === 'Bash') {
    bashDecision(String(input.tool_input?.command ?? ''))
    allow()
  }

  const filePath = input?.tool_input?.file_path ?? input?.tool_input?.notebook_path
  if (!filePath) allow()

  // Outside the project (scratchpad, home dir, another repo) — not our business.
  const rel = relative(root, resolve(root, filePath))
  if (rel.startsWith('..') || resolve(root, filePath) === resolve(root)) allow()

  const relPosix = rel.split(sep).join('/')

  // Gate 0 — protected files. Holds whether or not the other gates are open.
  protectedFileDecision(relPosix, input, root)

  if (ALWAYS_ALLOWED.some((re) => re.test(relPosix))) allow()

  // Gate 1 — Product Function milestones.
  const pf = read(join(cuiDir, 'product-functions.yaml'))
  const hasMilestones = pf && /^\s*-\s*key:\s*\S+/m.test(pf)
  if (!hasMilestones) {
    deny(
      `Blocked writing ${relPosix}: Product Function milestones are not defined yet.\n\n` +
      `This project gates implementation until the product is agreed. Run the ` +
      `pf-milestones skill (or /cui:pf) to interview the user and write ` +
      `.cui/product-functions.yaml, and get the user's explicit approval of the list.\n\n` +
      `Docs, .cui/, demos/ and the cui/ app remain writable. Do not route ` +
      `implementation code through those paths to get around this.`,
    )
  }

  // Gate 2 — repo blueprint.
  const bp = read(join(cuiDir, 'blueprint.yaml'))
  const locked = bp && /^\s*locked:\s*true\s*$/m.test(bp)
  if (!locked) {
    deny(
      `Blocked writing ${relPosix}: the repo blueprint is not locked.\n\n` +
      `Milestones are defined, but where code lives has not been decided. Run the ` +
      `repo-blueprint skill (or /cui:blueprint) to agree the directory layout, boundary rules, ` +
      `entry points and command catalogue, then set locked: true in .cui/blueprint.yaml.`,
    )
  }

  // Gate 3 — the blueprint is locked, so a new top-level directory is a structural decision
  // the user makes, not an implementation detail. Dot-directories are tool config, not code.
  const topLevel = relPosix.split('/')[0]
  if (relPosix.includes('/') && !topLevel.startsWith('.') && !blueprintTopLevels(bp).has(topLevel)) {
    deny(
      `Blocked writing ${relPosix}: "${topLevel}/" is not in the locked blueprint.\n\n` +
      `First check ARCHITECTURE.md — most code has a home already. If it genuinely needs a new ` +
      `top-level directory, that is a blueprint amendment, and the user approves those.\n\n${PROPOSE}`,
    )
  }

  allow()
}

main().catch(() => process.exit(0))
