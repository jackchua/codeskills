#!/usr/bin/env node
// PreToolUse gate: refuse implementation writes until PF milestones are approved and the
// repo blueprint is locked. Opt-in per project — a repo without a .cui/ directory is never
// gated, so installing this plugin globally is safe.

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

const main = async () => {
  let input
  try { input = JSON.parse(await readStdin()) } catch { allow() }

  const filePath = input?.tool_input?.file_path ?? input?.tool_input?.notebook_path
  if (!filePath) allow()

  const root = findProjectRoot(input.cwd || process.cwd())
  if (!root) allow()

  const cuiDir = join(root, '.cui')
  if (!existsSync(cuiDir)) allow() // not a CUI-managed project

  const config = read(join(cuiDir, 'config.yaml')) ?? ''
  if (/^\s*enforce:\s*false\s*$/m.test(config)) allow()

  // Outside the project (scratchpad, home dir, another repo) — not our business.
  const rel = relative(root, resolve(filePath))
  if (rel.startsWith('..') || resolve(filePath) === resolve(root)) allow()

  const relPosix = rel.split(sep).join('/')
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

  // Gate 3 — the blueprint is locked, so new top-level directories are a structural
  // decision, not an implementation detail. Warn rather than block; the skill owns amendments.
  const topLevel = relPosix.split('/')[0]
  if (relPosix.includes('/') && bp && !bp.includes(topLevel)) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason:
          `Note: "${topLevel}/" is not in the locked blueprint. If this is a new structural ` +
          `home for code, amend .cui/blueprint.yaml (repo-blueprint skill) and say so in the ` +
          `commit's Blueprint: trailer rather than letting the layout drift.`,
      },
    }))
    process.exit(0)
  }

  allow()
}

main().catch(() => process.exit(0))
