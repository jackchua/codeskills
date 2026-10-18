import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadConfig } from '../template/cui/src/server/config.mjs'
import { parseJUnit, evaluate, ratchet, check, recordBaseline, readState } from '../template/cui/src/server/registry.mjs'
import { approve, reject, createProposal, pendingApprovals, acceptRatchet } from '../template/cui/src/server/approvals.mjs'
import * as TDD from '../template/cui/src/server/tdd.mjs'

// ---------------------------------------------------------------- fixtures

const junit = (cases) => `<?xml version="1.0"?>
<testsuites>
  <testsuite name="suite">
${cases.map(([name, status, msg]) => status === 'passed'
    ? `    <testcase name="${name}" classname="c"/>`
    : status === 'skipped'
      ? `    <testcase name="${name}" classname="c"><skipped/></testcase>`
      : `    <testcase name="${name}" classname="c"><failure message="${msg ?? 'expected 1 to be 2'}">trace</failure></testcase>`).join('\n')}
  </testsuite>
</testsuites>
`

const feature = (id, status = 'active', cases = 1, milestone = 'PF-1') => ({
  id, title: id, milestone, status,
  test_plan: Array.from({ length: cases }, (_, i) => ({ level: 'unit', case: `case ${i + 1}` })),
})

const results = (tests) => ({ files: ['r.xml'], tests: parseJUnit(junit(tests)), at: null })

// ------------------------------------------------------------------- junit

describe('parseJUnit', () => {
  test('reads tags from the name, the classname and enclosing suites', () => {
    const xml = `<testsuites>
      <testsuite name="[FR-MAIL-001] sending">
        <testsuite name="nested">
          <testcase name="stores in Sent" classname="mail.test.ts"/>
        </testsuite>
      </testsuite>
      <testsuite name="other">
        <testcase name="[FR-MAIL-002] [FR-AUTH-001] needs a session" classname="x"/>
        <testcase name="untagged" classname="[FR-DRIVE-003] drive.test.ts"/>
      </testsuite>
    </testsuites>`
    const t = parseJUnit(xml)
    assert.deepEqual(t.map((x) => x.features), [['FR-MAIL-001'], ['FR-MAIL-002', 'FR-AUTH-001'], ['FR-DRIVE-003']])
    assert.equal(t[0].name, '[FR-MAIL-001] sending › nested › stores in Sent')
  })

  test('reads pytest-style feature properties', () => {
    const xml = `<testsuite name="pytest"><testcase name="test_send" classname="tests.test_mail">
      <properties><property name="feature" value="FR-MAIL-001"/></properties></testcase></testsuite>`
    assert.deepEqual(parseJUnit(xml)[0].features, ['FR-MAIL-001'])
  })

  test('distinguishes passed, failed, errored and skipped, and decodes entities', () => {
    const xml = `<testsuite name="s">
      <testcase name="a"/>
      <testcase name="b"><failure message="expected &quot;x&quot; &amp; y"/></testcase>
      <testcase name="c"><error message="TypeError: boom">stack</error></testcase>
      <testcase name="d"><skipped/></testcase>
    </testsuite>`
    const t = parseJUnit(xml)
    assert.deepEqual(t.map((x) => x.status), ['passed', 'failed', 'failed', 'skipped'])
    assert.equal(t[1].message, 'expected "x" & y')
    assert.equal(t[2].kind, 'error')
  })
})

// ---------------------------------------------------------------- evaluate

describe('evaluate', () => {
  const ms = new Map([['PF-1', { key: 'PF-1', status: 'in_progress' }]])

  test('an active feature with a passing tagged test passes', () => {
    const r = evaluate({ features: [feature('FR-A-001')], exceptions: [] }, results([['[FR-A-001] works', 'passed']]), ms)
    assert.equal(r.ok, true)
    assert.equal(r.features[0].state, 'passing')
  })

  test('an active feature with no passing test fails the check', () => {
    const r = evaluate({ features: [feature('FR-A-001')], exceptions: [] }, results([['unrelated', 'passed']]), ms)
    assert.equal(r.ok, false)
    assert.equal(r.features[0].state, 'untested')
    assert.match(r.errors[0].message, /no passing test is tagged \[FR-A-001\]/)
  })

  test('a skipped test is not a passing test', () => {
    const r = evaluate({ features: [feature('FR-A-001')], exceptions: [] }, results([['[FR-A-001] x', 'skipped']]), ms)
    assert.equal(r.features[0].state, 'untested')
  })

  test('a failing tagged test fails the feature even when others pass', () => {
    const r = evaluate({ features: [feature('FR-A-001')], exceptions: [] },
      results([['[FR-A-001] a', 'passed'], ['[FR-A-001] b', 'failed']]), ms)
    assert.equal(r.features[0].state, 'failing')
    assert.equal(r.ok, false)
  })

  test('planned features need no tests', () => {
    const r = evaluate({ features: [feature('FR-A-001', 'planned')], exceptions: [] }, results([]), ms)
    assert.equal(r.ok, true)
  })

  test('a tag pointing at an unregistered feature is an error', () => {
    const r = evaluate({ features: [feature('FR-A-001')], exceptions: [] },
      results([['[FR-A-001] a', 'passed'], ['[FR-A-01] typo', 'passed']]), ms)
    assert.ok(r.errors.some((e) => e.rule === 'orphan-tag' && e.id === 'FR-A-01'))
  })

  test('an approved, unexpired exception excuses an untested feature', () => {
    const ex = { id: 'EX-1', feature: 'FR-A-001', category: 'visual', reason: 'pixel output',
                 verification: 'manual checklist', expires: '2999-01-01', status: 'approved' }
    const r = evaluate({ features: [feature('FR-A-001')], exceptions: [ex] }, results([]), ms)
    assert.equal(r.features[0].state, 'excepted')
    assert.ok(!r.errors.some((e) => e.rule === 'untested'))
  })

  test('a proposed exception excuses nothing and is itself an error', () => {
    const ex = { id: 'EX-1', feature: 'FR-A-001', category: 'visual', verification: 'm', expires: '2999-01-01', status: 'proposed' }
    const r = evaluate({ features: [feature('FR-A-001')], exceptions: [ex] }, results([]), ms)
    assert.ok(r.errors.some((e) => e.rule === 'approval'))
    assert.ok(r.errors.some((e) => e.rule === 'untested'))
  })

  test('an expired exception is an error', () => {
    const ex = { id: 'EX-1', feature: 'FR-A-001', category: 'visual', verification: 'm', expires: '2020-01-01', status: 'approved' }
    const r = evaluate({ features: [feature('FR-A-001')], exceptions: [ex] }, results([]), ms, { today: '2026-10-17' })
    assert.ok(r.errors.some((e) => e.rule === 'expired'))
  })

  test('a flaky-test exception quarantines only the named test', () => {
    const ex = { id: 'EX-2', feature: 'FR-A-001', category: 'flaky', verification: 'retried nightly',
                 expires: '2999-01-01', status: 'approved', test: 'races the clock' }
    const r = evaluate({ features: [feature('FR-A-001')], exceptions: [ex] },
      results([['[FR-A-001] works', 'passed'], ['[FR-A-001] races the clock', 'failed']]), ms)
    assert.equal(r.features[0].state, 'passing')
    assert.equal(r.features[0].tests[1].status, 'quarantined')
  })

  test('a done milestone with planned features is an error', () => {
    const done = new Map([['PF-1', { key: 'PF-1', status: 'done' }]])
    const r = evaluate({ features: [feature('FR-A-001', 'planned')], exceptions: [] }, results([]), done)
    assert.ok(r.errors.some((e) => e.rule === 'milestone'))
  })

  test('duplicate ids, missing test plans and unknown milestones are errors', () => {
    const r = evaluate({ features: [feature('FR-A-001'), feature('FR-A-001'), { ...feature('FR-A-002', 'planned', 0) },
                                    feature('FR-A-003', 'planned', 1, 'PF-9')], exceptions: [] }, results([]), ms)
    assert.deepEqual(new Set(r.errors.map((e) => e.rule)), new Set(['duplicate', 'plan', 'milestone', 'untested']))
  })

  test('no result files with active features is an error, not a pass', () => {
    const r = evaluate({ features: [feature('FR-A-001')], exceptions: [] }, { files: [], tests: [] }, ms)
    assert.ok(r.errors.some((e) => e.rule === 'no-results'))
  })
})

// ----------------------------------------------------------------- ratchet

describe('ratchet', () => {
  const state = (features, extra = {}) => ({
    features, exceptions: [], blueprint: { locked: true, hash: 'h1' }, baseline: {}, ...extra,
  })

  test('removing, retiring, demoting and shrinking are all reported', () => {
    const base = state([feature('FR-A-001'), feature('FR-A-002'), feature('FR-A-003'), feature('FR-A-004', 'active', 3)])
    const head = state([feature('FR-A-002', 'retired'), feature('FR-A-003', 'planned'), feature('FR-A-004', 'active', 2)])
    assert.deepEqual(ratchet(base, head).map((i) => `${i.kind} ${i.id}`), [
      'feature-removed FR-A-001', 'feature-retired FR-A-002', 'feature-demoted FR-A-003', 'plan-shrunk FR-A-004',
    ])
  })

  test('adding features and promoting planned to active are not', () => {
    const base = state([feature('FR-A-001', 'planned')])
    const head = state([feature('FR-A-001', 'active', 2), feature('FR-A-002', 'planned')])
    assert.deepEqual(ratchet(base, head), [])
  })

  test('fewer tagged tests than the base baseline is reported, using what actually ran', () => {
    const base = state([feature('FR-A-001')], { baseline: { 'FR-A-001': { tests: 3 } } })
    const head = state([feature('FR-A-001')])
    const ev = evaluate(head, results([['[FR-A-001] a', 'passed'], ['[FR-A-001] b', 'skipped']]))
    assert.deepEqual(ratchet(base, head, ev), [{ kind: 'tests-removed', id: 'FR-A-001', from: 3, to: 1 }])
  })

  test('a newly approved exception and a changed locked blueprint are reported', () => {
    const ex = { id: 'EX-1', feature: 'FR-A-001', status: 'approved', expires: '2027-01-01' }
    const items = ratchet(state([]), state([], { exceptions: [ex], blueprint: { locked: true, hash: 'h2' } }))
    assert.deepEqual(items.map((i) => i.kind), ['exception-approved', 'blueprint-changed'])
  })
})

// --------------------------------------------- end to end: approvals and tdd

describe('approvals, the ratchet in CI, and tdd — in a real repo', () => {
  let root, cfg
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const writeResults = (tests) => {
    mkdirSync(join(root, 'test-results'), { recursive: true })
    writeFileSync(join(root, 'test-results/junit.xml'), junit(tests))
  }
  const FEATURES = `version: 1
features:
  - id: FR-MAIL-001
    title: "Send a message"
    milestone: PF-1
    status: active
    test_plan:
      - level: integration
        case: "lands in Sent and Inbox"
  - id: FR-MAIL-002
    title: "Attachments"
    milestone: PF-1
    status: active
    test_plan:
      - level: unit
        case: "rejects over 25MB"
`

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'cui-registry-'))
    mkdirSync(join(root, '.cui'), { recursive: true })
    writeFileSync(join(root, '.cui/config.yaml'), 'enforce: true\n')
    writeFileSync(join(root, '.cui/product-functions.yaml'), 'version: 1\nmilestones:\n  - key: PF-1\n    title: Mail\n    status: in_progress\n')
    writeFileSync(join(root, '.cui/blueprint.yaml'), 'version: 1\nlocked: true\nlayout:\n  - path: src\n')
    writeFileSync(join(root, '.cui/features.yaml'), FEATURES)
    writeFileSync(join(root, '.gitignore'), 'test-results/\n')
    git('init', '-q'); git('config', 'user.email', 'owner@example.com'); git('config', 'user.name', 'Owner')
    cfg = loadConfig(root)
    writeResults([['[FR-MAIL-001] send', 'passed'], ['[FR-MAIL-002] big', 'passed'], ['[FR-MAIL-002] small', 'passed']])
    const r = check(cfg)
    assert.equal(r.ok, true, JSON.stringify(r.errors))
    recordBaseline(cfg, r)
    git('add', '-A'); git('commit', '-q', '-m', 'base')
  })
  after(() => rmSync(root, { recursive: true, force: true }))

  test('baseline records what ran and never lowers on its own', () => {
    const b = JSON.parse(readFileSync(join(root, '.cui/registry-baseline.json'), 'utf8'))
    assert.deepEqual(b.features, { 'FR-MAIL-001': { tests: 1 }, 'FR-MAIL-002': { tests: 2 } })
    writeResults([['[FR-MAIL-001] send', 'passed'], ['[FR-MAIL-002] big', 'passed']])
    recordBaseline(cfg, check(cfg))
    assert.equal(JSON.parse(readFileSync(join(root, '.cui/registry-baseline.json'), 'utf8')).features['FR-MAIL-002'].tests, 2)
  })

  test('a deleted test fails CI until a human approves the removal', () => {
    // results still have FR-MAIL-002 at one test, from the previous step
    const r = check(cfg, { base: 'HEAD' })
    assert.equal(r.ok, false)
    assert.match(r.errors.find((e) => e.rule === 'ratchet').message, /FR-MAIL-002 ran 1 tagged test\(s\), down from 2/)

    assert.throws(() => createProposal(cfg, { kind: 'tests', feature: 'FR-MAIL-002', min: 1, title: 'x', why: 'dup' }), /say why/)
    const p = createProposal(cfg, { kind: 'tests', feature: 'FR-MAIL-002', min: 1, title: 'Merge duplicate size tests',
                                    why: 'big and small asserted the same boundary twice' })
    assert.equal(pendingApprovals(cfg).proposals.length, 1)
    approve(cfg, p.id)
    assert.equal(check(cfg, { base: 'HEAD' }).ok, true)
    git('add', '-A'); git('commit', '-q', '-m', 'merge tests')
  })

  test('retiring a feature needs an approved proposal; the approval covers it in CI', () => {
    const retired = FEATURES.replace(/(id: FR-MAIL-002[\s\S]*?status: )active/, '$1retired')
    writeFileSync(join(root, 'draft.yaml'), retired)
    const p = createProposal(cfg, { kind: 'file', target: '.cui/features.yaml', content: retired,
                                    title: 'Retire attachments', why: 'attachments moved to Drive links in PF-3' })
    // Before approval, nothing changed on disk.
    assert.equal(readState(cfg).features[1].status, 'active')
    const r = approve(cfg, p.id)
    assert.deepEqual(r.allows.map((a) => a.kind), ['feature-retired'])
    assert.equal(readState(cfg).features[1].status, 'retired')
    assert.equal(check(cfg, { base: 'HEAD' }).ok, true)
  })

  test('a stale proposal is refused', () => {
    const p = createProposal(cfg, { kind: 'file', target: '.cui/blueprint.yaml', content: 'version: 1\nlocked: true\nlayout:\n  - path: src\n  - path: workers\n',
                                    title: 'Add workers', why: 'PF-4 needs a background queue consumer' })
    writeFileSync(join(root, '.cui/blueprint.yaml'), 'version: 1\nlocked: true\nlayout:\n  - path: src\n# edited\n')
    assert.throws(() => approve(cfg, p.id), /changed after/)
    reject(cfg, p.id, { note: 'redo it' })
    writeFileSync(join(root, '.cui/blueprint.yaml'), 'version: 1\nlocked: true\nlayout:\n  - path: src\n')
  })

  test('a hand-approved exception (status flipped without cui approve) fails CI', () => {
    writeFileSync(join(root, '.cui/exceptions.yaml'), `version: 1
exceptions:
  - id: EX-1
    feature: FR-MAIL-001
    category: visual
    reason: "rendering"
    verification: "manual"
    expires: "2999-01-01"
    status: approved
`)
    const r = check(cfg, { base: 'HEAD' })
    assert.ok(r.errors.some((e) => e.rule === 'ratchet' && e.id === 'EX-1'))
    writeFileSync(join(root, '.cui/exceptions.yaml'), readFileSync(join(root, '.cui/exceptions.yaml'), 'utf8').replace('approved', 'proposed'))
    approve(cfg, 'EX-1')
    assert.ok(!check(cfg, { base: 'HEAD' }).errors.some((e) => e.rule === 'ratchet'))
  })

  test('cui ratchet accept records a human\'s own direct edit', () => {
    git('add', '-A'); git('commit', '-q', '-m', 'wip')
    // FR-MAIL-001 is the first, still-active feature; a human demotes it by hand.
    writeFileSync(join(root, '.cui/features.yaml'), readFileSync(join(root, '.cui/features.yaml'), 'utf8').replace('status: active', 'status: planned'))
    assert.equal(check(cfg, { base: 'HEAD' }).ok, false)
    const r = acceptRatchet(cfg, 'HEAD', { note: 'not ready after all' })
    assert.deepEqual(r.items.map((i) => i.kind), ['feature-demoted'])
    assert.equal(check(cfg, { base: 'HEAD' }).ok, true)
  })

  test('tdd: red must fail on assertions, green must pass the same tests, then promote', () => {
    writeFileSync(join(root, '.cui/features.yaml'), `${readFileSync(join(root, '.cui/features.yaml'), 'utf8')}  - id: FR-MAIL-003
    title: "Drafts"
    milestone: PF-1
    status: planned
    test_plan:
      - level: unit
        case: "autosaves"
`)
    // A fake test runner: writes whatever JUnit is in $FAKE_JUNIT.
    writeFileSync(join(root, 'fake-test.mjs'), `import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
mkdirSync('test-results', { recursive: true })
writeFileSync('test-results/junit.xml', readFileSync(process.env.FAKE_JUNIT, 'utf8'))`)
    const run = (tests) => {
      writeFileSync(join(root, 'fake.xml'), junit(tests))
      return `FAKE_JUNIT=fake.xml node fake-test.mjs`
    }

    assert.throws(() => TDD.red(cfg, 'FR-MAIL-003', { cmd: run([['[FR-MAIL-003] autosaves', 'passed']]) }), /already pass/)
    assert.throws(() => TDD.red(cfg, 'FR-MAIL-003', { cmd: run([['[FR-MAIL-003] autosaves', 'failed', 'Cannot find module ./drafts']]) }), /load or syntax error/)
    assert.throws(() => TDD.green(cfg, 'FR-MAIL-003', { cmd: run([]) }), /no red recorded/)

    const r = TDD.red(cfg, 'FR-MAIL-003', { cmd: run([['[FR-MAIL-003] autosaves', 'failed'], ['[FR-MAIL-003] restores', 'failed']]) })
    assert.equal(r.failing, 2)

    assert.throws(() => TDD.green(cfg, 'FR-MAIL-003', { cmd: run([['[FR-MAIL-003] autosaves', 'passed']]) }), /were red are not passing/)
    const g = TDD.green(cfg, 'FR-MAIL-003', { cmd: run([['[FR-MAIL-003] autosaves', 'passed'], ['[FR-MAIL-003] restores', 'passed']]) })
    assert.equal(g.promoted, true)
    assert.match(g.trailer, /^Feature: FR-MAIL-003 red→green/)
    assert.equal(readState(cfg).features.find((f) => f.id === 'FR-MAIL-003').status, 'active')
    assert.ok(existsSync(join(root, '.cui/tdd/FR-MAIL-003.json')))
    git('add', '-A'); git('commit', '-q', '-m', 'feat: drafts\n\nFeature: FR-MAIL-003 red→green')
    assert.equal(TDD.verifiedAt(cfg, 'FR-MAIL-003', git('rev-parse', 'HEAD').trim()), true)
  })
})
