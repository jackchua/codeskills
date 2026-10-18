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

  test('a directory outside the locked blueprint is blocked, pointing at a proposal', () => {
    const r = write('lib/b.ts')
    assert.equal(decision(r), 'deny')
    assert.match(r.hookSpecificOutput.permissionDecisionReason, /not in the locked blueprint/i)
    assert.match(r.hookSpecificOutput.permissionDecisionReason, /cui\/bin\/cui\.mjs propose/)
  })

  test('root files and dot-directories are not structural', () => {
    assert.equal(decision(write('package.json')), 'allow')
    assert.equal(decision(write('.vscode/settings.json')), 'allow')
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

describe('protected files', () => {
  const FEATURES = `version: 1
features:
  - id: FR-MAIL-001
    title: "Send"
    milestone: PF-1
    status: active
    test_plan:
      - level: unit
        case: "a"
      - level: e2e
        case: "b"
  - id: FR-MAIL-002
    title: "Drafts"
    milestone: PF-1
    status: planned
    test_plan:
      - level: unit
        case: "c"
`
  const edit = (relPath, old_string, new_string) => runHook(GATE, {
    cwd: root, tool_name: 'Edit', tool_input: { file_path: join(root, relPath), old_string, new_string },
  })
  const writeContent = (relPath, content) => runHook(GATE, {
    cwd: root, tool_name: 'Write', tool_input: { file_path: join(root, relPath), content },
  })
  const bash = (command) => runHook(GATE, { cwd: root, tool_name: 'Bash', tool_input: { command } })

  before(() => {
    writeFileSync(join(root, '.cui/features.yaml'), FEATURES)
    writeFileSync(join(root, '.cui/exceptions.yaml'), `version: 1
exceptions:
  - id: EX-1
    feature: FR-MAIL-001
    status: proposed
    expires: "2027-01-01"
`)
  })

  test('the locked blueprint cannot be edited directly', () => {
    const r = edit('.cui/blueprint.yaml', 'purpose: "code"', 'purpose: "anything"')
    assert.equal(decision(r), 'deny')
    assert.match(r.hookSpecificOutput.permissionDecisionReason, /locked/)
  })

  test('adding a feature, adding a plan case and promoting planned to active are allowed', () => {
    assert.equal(decision(edit('.cui/features.yaml', '    status: planned', '    status: active')), 'allow')
    assert.equal(decision(writeContent('.cui/features.yaml', `${FEATURES}  - id: FR-MAIL-003
    title: "Search"
    status: planned
    test_plan:
      - level: unit
        case: "d"
`)), 'allow')
    assert.equal(decision(edit('.cui/features.yaml', '        case: "c"\n', '        case: "c"\n      - level: e2e\n        case: "c2"\n')), 'allow')
  })

  test('removing, retiring, demoting or shrinking a feature is blocked', () => {
    const removed = FEATURES.replace(/  - id: FR-MAIL-002[\s\S]*$/, '')
    assert.match(writeContent('.cui/features.yaml', removed).hookSpecificOutput.permissionDecisionReason, /removes FR-MAIL-002/)
    assert.match(edit('.cui/features.yaml', '    status: active', '    status: retired').hookSpecificOutput.permissionDecisionReason, /retires FR-MAIL-001/)
    assert.match(edit('.cui/features.yaml', '    status: active', '    status: planned').hookSpecificOutput.permissionDecisionReason, /demotes FR-MAIL-001/)
    assert.match(edit('.cui/features.yaml', '      - level: e2e\n        case: "b"\n', '').hookSpecificOutput.permissionDecisionReason, /shrinks FR-MAIL-001/)
  })

  test('lowering risk, lowering a mutation threshold or narrowing source is blocked', () => {
    const MUT = FEATURES.replace('    status: active\n', '    status: active\n    risk: high\n    mutation_threshold: 80\n    source:\n      - "src/send/**"\n      - src/mime.ts\n')
    writeFileSync(join(root, '.cui/features.yaml'), MUT)
    const reason = (o, n) => edit('.cui/features.yaml', o, n)?.hookSpecificOutput?.permissionDecisionReason ?? 'allow'
    assert.match(reason('risk: high', 'risk: normal'), /lowers FR-MAIL-001 from risk: high/)
    assert.match(reason('mutation_threshold: 80', 'mutation_threshold: 60'), /lowers FR-MAIL-001's mutation threshold/)
    assert.match(reason('      - src/mime.ts\n', ''), /removes src\/mime.ts from FR-MAIL-001's source/)
    assert.equal(reason('mutation_threshold: 80', 'mutation_threshold: 85'), 'allow')
    assert.equal(reason('      - src/mime.ts\n', '      - src/mime.ts\n      - src/smtp.ts\n'), 'allow')
    // inline form
    writeFileSync(join(root, '.cui/features.yaml'), MUT.replace('    source:\n      - "src/send/**"\n      - src/mime.ts\n', '    source: ["src/send/**", src/mime.ts]\n'))
    assert.match(reason('source: ["src/send/**", src/mime.ts]', 'source: ["src/send/**"]'), /removes src\/mime.ts/)
    writeFileSync(join(root, '.cui/features.yaml'), FEATURES)
  })

  test('the agent can propose an exception but never approve one', () => {
    assert.equal(decision(edit('.cui/exceptions.yaml', '"2027-01-01"', '"2027-02-01"')), 'allow')
    const r = edit('.cui/exceptions.yaml', 'status: proposed', 'status: approved')
    assert.equal(decision(r), 'deny')
    assert.match(r.hookSpecificOutput.permissionDecisionReason, /cui approve EX-1/)
  })

  test('tool-owned files are never written directly', () => {
    for (const p of ['.cui/approvals.log', '.cui/registry-baseline.json', '.cui/tdd/FR-MAIL-001.json', '.cui/mutation/FR-MAIL-001.json']) {
      assert.equal(decision(writeContent(p, '{}')), 'deny', p)
    }
  })

  test('the CI workflow is protected once it exists', () => {
    assert.equal(decision(writeContent('.github/workflows/cui.yml', 'x')), 'allow')
    mkdirSync(join(root, '.github/workflows'), { recursive: true })
    writeFileSync(join(root, '.github/workflows/cui.yml'), 'name: cui\n')
    assert.equal(decision(writeContent('.github/workflows/cui.yml', 'x')), 'deny')
    assert.equal(decision(writeContent('.github/workflows/other.yml', 'x')), 'allow')
  })

  test('the shell cannot approve, or write protected files', () => {
    for (const cmd of [
      'node cui/bin/cui.mjs approve EX-1',
      'npx cui reject 2026-10-17-x',
      'node cui/bin/cui.mjs ratchet accept --base main',
      'curl -X POST localhost:4317/api/approvals/EX-1',
      'echo x >> .cui/approvals.log',
      "sed -i '' 's/active/retired/' .cui/features.yaml",
      'cat draft.yaml > .cui/blueprint.yaml',
      'echo {} | tee .cui/registry-baseline.json',
      'rm -rf .cui/tdd',
      'git checkout -- .cui/exceptions.yaml',
      'cp /tmp/f.yaml .cui/features.yaml',
      'echo {} > .cui/mutation/FR-MAIL-001.json',
    ]) assert.equal(decision(bash(cmd)), 'deny', cmd)
  })

  test('the shell can still read protected files and run the cui tools', () => {
    for (const cmd of [
      'cat .cui/features.yaml',
      'grep FR- .cui/features.yaml > /tmp/ids.txt',
      'cp .cui/features.yaml /tmp/backup.yaml',
      'node cui/bin/cui.mjs registry check --record',
      'node cui/bin/cui.mjs tdd green FR-MAIL-001',
      'node cui/bin/cui.mjs approvals',
      'node cui/bin/cui.mjs mutation --feature FR-MAIL-001',
      'git status && git diff .cui/features.yaml',
    ]) assert.equal(decision(bash(cmd)), 'allow', cmd)
  })
})

describe('the SessionStart context hook', () => {
  test('reports gate state and milestone progress', () => {
    const r = runHook(SESSION, { cwd: root, hook_event_name: 'SessionStart', source: 'startup' })
    const ctx = r.hookSpecificOutput.additionalContext
    assert.match(ctx, /STATUS: gates open/)
    assert.match(ctx, /PF-1 \(not_started\) \[1\/2 criteria\] — Ship a thing/)
    assert.match(ctx, /ship-commit skill/)
    assert.match(ctx, /Feature registry: 1 active, 1 planned, 0 retired/)
    assert.match(ctx, /1 item\(s\) are waiting on the user's approval/)
    assert.match(ctx, /cui tdd red FR-X/)
  })

  test('says nothing at all in a non-CUI project', () => {
    const out = execFileSync('node', [SESSION], {
      input: JSON.stringify({ cwd: tmpdir(), hook_event_name: 'SessionStart' }),
      encoding: 'utf8',
    })
    assert.equal(out.trim(), '')
  })
})
