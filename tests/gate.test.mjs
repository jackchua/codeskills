import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const GATE = resolve(HERE, '../plugins/cui/hooks/gate.mjs')
const SESSION = resolve(HERE, '../plugins/cui/hooks/session-context.mjs')

let root

const PF_OK = `version: 1
milestones:
  - key: PF-1
    title: "Ship a thing"
    status: not_started
    acceptance:
      - id: PF-1.1
        text: "x"
        status: met
      - id: PF-1.2
        text: "y"
        status: open
`
const BP_LOCKED = `version: 1
locked: true
layout:
  - path: src
    purpose: "code"
`

/** Runs a hook the way Claude Code does: JSON on stdin, JSON or nothing on stdout. */
function runHook(script, payload) {
  const out = execFileSync('node', [script], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
  })
  return out.trim() ? JSON.parse(out) : null
}

const write = (relPath) => runHook(GATE, {
  cwd: root,
  tool_name: 'Write',
  tool_input: { file_path: join(root, relPath) },
})

const decision = (r) => r?.hookSpecificOutput?.permissionDecision ?? 'allow'

before(() => {
  root = mkdtempSync(join(tmpdir(), 'cui-gate-'))
  mkdirSync(join(root, 'src'), { recursive: true })
})
after(() => rmSync(root, { recursive: true, force: true }))

describe('the PreToolUse gate', () => {
  test('a repo with no .cui/ is never gated', () => {
    assert.equal(decision(write('src/a.ts')), 'allow')
  })

  test('.cui/ present but no milestones blocks implementation writes', () => {
    mkdirSync(join(root, '.cui'), { recursive: true })
    writeFileSync(join(root, '.cui/config.yaml'), 'enforce: true\n')
    const r = write('src/a.ts')
    assert.equal(decision(r), 'deny')
    assert.match(r.hookSpecificOutput.permissionDecisionReason, /milestones are not defined/i)
  })

  test('docs, .cui/, demos/ and cui/ stay writable while gated', () => {
    for (const p of ['README.md', 'docs/guide.md', '.cui/product-functions.yaml',
                     'demos/001-x/run.sh', 'cui/src/server/db.mjs', '.gitignore']) {
      assert.equal(decision(write(p)), 'allow', `${p} should be writable`)
    }
  })

  test('milestones without a locked blueprint still blocks', () => {
    writeFileSync(join(root, '.cui/product-functions.yaml'), PF_OK)
    const r = write('src/a.ts')
    assert.equal(decision(r), 'deny')
    assert.match(r.hookSpecificOutput.permissionDecisionReason, /blueprint is not locked/i)
  })

  test('locked: false is not locked', () => {
    writeFileSync(join(root, '.cui/blueprint.yaml'), 'version: 1\nlocked: false\n')
    assert.equal(decision(write('src/a.ts')), 'deny')
  })

  test('both gates satisfied allows writes inside the blueprint', () => {
    writeFileSync(join(root, '.cui/blueprint.yaml'), BP_LOCKED)
    assert.equal(decision(write('src/a.ts')), 'allow')
  })

  test('a directory outside the blueprint is allowed, but flagged', () => {
    const r = write('lib/b.ts')
    assert.equal(decision(r), 'allow')
    assert.match(r.hookSpecificOutput.permissionDecisionReason, /not in the locked blueprint/i)
  })

  test('enforce: false lifts the gates entirely', () => {
    writeFileSync(join(root, '.cui/config.yaml'), 'enforce: false\n')
    rmSync(join(root, '.cui/product-functions.yaml'))
    assert.equal(decision(write('src/a.ts')), 'allow')
    writeFileSync(join(root, '.cui/config.yaml'), 'enforce: true\n')
    writeFileSync(join(root, '.cui/product-functions.yaml'), PF_OK)
  })

  test('paths outside the project are none of our business', () => {
    const r = runHook(GATE, {
      cwd: root, tool_name: 'Write',
      tool_input: { file_path: '/tmp/somewhere-else/x.ts' },
    })
    assert.equal(decision(r), 'allow')
  })

  test('malformed input fails open rather than blocking the session', () => {
    const out = execFileSync('node', [GATE], { input: 'not json', encoding: 'utf8' })
    assert.equal(out.trim(), '')
  })
})

describe('the SessionStart context hook', () => {
  test('reports gate state and milestone progress', () => {
    const r = runHook(SESSION, { cwd: root, hook_event_name: 'SessionStart', source: 'startup' })
    const ctx = r.hookSpecificOutput.additionalContext
    assert.match(ctx, /STATUS: gates open/)
    assert.match(ctx, /PF-1 \(not_started\) \[1\/2 criteria\] — Ship a thing/)
    assert.match(ctx, /ship-commit skill/)
  })

  test('says nothing at all in a non-CUI project', () => {
    const out = execFileSync('node', [SESSION], {
      input: JSON.stringify({ cwd: tmpdir(), hook_event_name: 'SessionStart' }),
      encoding: 'utf8',
    })
    assert.equal(out.trim(), '')
  })
})
