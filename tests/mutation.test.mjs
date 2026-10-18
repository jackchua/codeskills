import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadConfig } from '../template/cui/src/server/config.mjs'
import { parseMutationReport, scoreFor, runMutation, changedFeatures } from '../template/cui/src/server/mutation.mjs'
import { evaluate, ratchet, isCovered, parseJUnit, check } from '../template/cui/src/server/registry.mjs'
import { acceptRatchet } from '../template/cui/src/server/approvals.mjs'

// A mutation-testing-report-schema report: src/send.js has 4 mutants, src/other.js 1.
const report = (statuses = ['Killed', 'Killed', 'Survived', 'NoCoverage']) => JSON.stringify({
  schemaVersion: '1',
  files: {
    'src/send.js': {
      language: 'javascript', source: '',
      mutants: [
        ...statuses.map((status, i) => ({
          id: String(i), mutatorName: i % 2 ? 'EqualityOperator' : 'ConditionalExpression', replacement: 'true',
          location: { start: { line: 10 + i, column: 1 }, end: { line: 10 + i, column: 5 } }, status,
        })),
        { id: 'c', mutatorName: 'StringLiteral', location: { start: { line: 1, column: 1 } }, status: 'CompileError' },
      ],
    },
    'src/other.js': { language: 'javascript', source: '', mutants: [{ id: 'o', mutatorName: 'X', location: { start: { line: 1 } }, status: 'Survived' }] },
  },
})

const feature = (extra = {}) => ({
  id: 'FR-MAIL-001', title: 'send', milestone: 'PF-1', status: 'active', risk: 'high', source: ['src/send.js'],
  test_plan: [{ level: 'unit', case: 'x' }], ...extra,
})
const passing = { files: ['r.xml'], tests: parseJUnit('<testsuite name="s"><testcase name="[FR-MAIL-001] a"/></testsuite>') }

describe('scoring', () => {
  test('score = killed / (killed + survived + uncovered), compile errors excluded, only the feature\'s files', () => {
    const s = scoreFor(parseMutationReport(report()), ['src/send.js'])
    assert.deepEqual([s.mutants, s.killed, s.survived, s.no_coverage, s.valid, s.score], [5, 2, 1, 1, 4, 50])
    assert.deepEqual(s.survivors.map((m) => `${m.status}@${m.line}`), ['Survived@12', 'NoCoverage@13'])
  })

  test('timeouts count as detected', () => {
    assert.equal(scoreFor(parseMutationReport(report(['Killed', 'Timeout'])), ['src/**']).score, 66.7)
  })
})

describe('evaluate: mutation and expiry rules', () => {
  const opts = { mutationThreshold: 60, mutationConfigured: true }

  test('a high-risk feature below threshold fails; at or above passes', () => {
    const low = { 'FR-MAIL-001': { feature: 'FR-MAIL-001', score: 50, survived: 1, no_coverage: 1 } }
    const r = evaluate({ features: [feature()], exceptions: [], mutation: low }, passing, new Map(), opts)
    assert.match(r.errors.find((e) => e.rule === 'mutation').message, /50% is below 60%/)
    const ok = evaluate({ features: [feature({ mutation_threshold: 50 })], exceptions: [], mutation: low }, passing, new Map(), opts)
    assert.ok(!ok.errors.some((e) => e.rule === 'mutation'))
  })

  test('never measured is an error once mutation_command is configured, a warning before', () => {
    assert.ok(evaluate({ features: [feature()], exceptions: [] }, passing, new Map(), opts).errors.some((e) => e.rule === 'mutation'))
    const r = evaluate({ features: [feature()], exceptions: [] }, passing, new Map(), { ...opts, mutationConfigured: false })
    assert.ok(!r.errors.some((e) => e.rule === 'mutation'))
    assert.ok(r.warnings.some((w) => w.rule === 'mutation'))
  })

  test('high risk with no source globs is an error; normal-risk and planned features are not measured', () => {
    assert.ok(evaluate({ features: [feature({ source: [] })], exceptions: [] }, passing, new Map(), opts).errors.some((e) => e.rule === 'mutation'))
    assert.ok(!evaluate({ features: [feature({ risk: 'normal' })], exceptions: [] }, passing, new Map(), opts).errors.length)
    assert.ok(!evaluate({ features: [feature({ status: 'planned' })], exceptions: [] }, passing, new Map(), opts).errors.length)
  })

  test('an approved exception inside the warning window produces an expiring warning', () => {
    const ex = (expires) => ({ id: 'EX-1', feature: 'FR-MAIL-001', category: 'visual', verification: 'v', status: 'approved', expires })
    const f = feature({ risk: 'normal' })
    const soon = evaluate({ features: [f], exceptions: [ex('2026-10-25')] }, passing, new Map(), { today: '2026-10-17', warnDays: 14 })
    assert.match(soon.warnings.find((w) => w.rule === 'expiring').message, /in 8 day\(s\)/)
    assert.equal(soon.summary.exceptions_expiring, 1)
    const later = evaluate({ features: [f], exceptions: [ex('2027-03-01')] }, passing, new Map(), { today: '2026-10-17', warnDays: 14 })
    assert.ok(!later.warnings.some((w) => w.rule === 'expiring'))
  })
})

describe('ratchet: mutation obligations', () => {
  const state = (features) => ({ features, exceptions: [], blueprint: { locked: false, hash: null }, baseline: {} })

  test('lowering risk, lowering a threshold, or narrowing source are reported', () => {
    const base = state([feature({ mutation_threshold: 80, source: ['src/send.js', 'src/mime.js'] })])
    const head = state([feature({ risk: 'normal', mutation_threshold: 70, source: ['src/send.js'] })])
    assert.deepEqual(ratchet(base, head).map((i) => i.kind), ['risk-lowered', 'threshold-lowered', 'source-narrowed'])
  })

  test('raising risk, raising a threshold, or adding source are not', () => {
    const base = state([feature({ risk: 'normal', mutation_threshold: 60 })])
    const head = state([feature({ mutation_threshold: 75, source: ['src/send.js', 'src/x.js'] })])
    assert.deepEqual(ratchet(base, head), [])
  })

  test('an approval covers only the threshold and globs it named', () => {
    const item = { kind: 'source-narrowed', id: 'FR-MAIL-001', globs: ['src/mime.js'] }
    assert.equal(isCovered(item, [{ allows: [{ kind: 'source-narrowed', id: 'FR-MAIL-001', globs: ['src/mime.js'] }] }]), true)
    assert.equal(isCovered({ ...item, globs: ['src/mime.js', 'src/a.js'] }, [{ allows: [{ kind: 'source-narrowed', id: 'FR-MAIL-001', globs: ['src/mime.js'] }] }]), false)
  })
})

describe('running mutation in a repo', () => {
  let root, cfg
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'cui-mutation-'))
    mkdirSync(join(root, '.cui'), { recursive: true })
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, '.cui/config.yaml'), 'enforce: true\nmutation_command: "node fake-stryker.mjs {files}"\n')
    writeFileSync(join(root, 'fake-stryker.mjs'), `import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
mkdirSync('reports/mutation', { recursive: true })
writeFileSync('args.txt', process.argv.slice(2).join(' '))
writeFileSync('reports/mutation/mutation.json', readFileSync('fixture.json', 'utf8'))`)
    writeFileSync(join(root, 'fixture.json'), report())
    git('init', '-q'); git('config', 'user.email', 'o@example.com'); git('config', 'user.name', 'O')
    writeFileSync(join(root, 'src/send.js'), '1\n'); git('add', '-A'); git('commit', '-q', '-m', 'base')
    cfg = loadConfig(root)
  })
  after(() => rmSync(root, { recursive: true, force: true }))

  test('runs the tool on the feature\'s globs and writes a summary per feature', () => {
    const [r] = runMutation(cfg, [feature()])
    assert.equal(readFileSync(join(root, 'args.txt'), 'utf8'), 'src/send.js')
    assert.equal(r.score, 50)
    assert.equal(r.passed, false)
    const saved = JSON.parse(readFileSync(join(root, '.cui/mutation/FR-MAIL-001.json'), 'utf8'))
    assert.equal(saved.threshold, 60)
    assert.equal(saved.survivors.length, 2)
  })

  test('the summary feeds the registry check', () => {
    writeFileSync(join(root, '.cui/features.yaml'), `version: 1
features:
  - id: FR-MAIL-001
    title: send
    status: active
    risk: high
    source: [src/send.js]
    test_plan:
      - level: unit
        case: x
`)
    mkdirSync(join(root, 'test-results'), { recursive: true })
    writeFileSync(join(root, 'test-results/j.xml'), '<testsuite name="s"><testcase name="[FR-MAIL-001] a"/></testsuite>')
    assert.ok(check(cfg).errors.some((e) => e.rule === 'mutation' && /50%/.test(e.message)))
    writeFileSync(join(root, 'fixture.json'), report(['Killed', 'Killed', 'Killed', 'Survived']))
    runMutation(cfg, [feature()])
    assert.ok(!check(cfg).errors.some((e) => e.rule === 'mutation'))
  })

  test('a stale report (tool wrote nothing) is refused', () => {
    assert.throws(() => runMutation(cfg, [feature()], { cmd: 'true' }), /no fresh report/)
  })

  test('changedFeatures picks only features whose source the branch touched', () => {
    git('add', '-A'); git('commit', '-q', '-m', 'registry')
    const base = git('rev-parse', 'HEAD').trim()
    writeFileSync(join(root, 'src/send.js'), '2\n'); git('add', '-A'); git('commit', '-q', '-m', 'change send')
    const fs = [feature(), feature({ id: 'FR-MAIL-002', source: ['src/other.js'] })]
    assert.deepEqual(changedFeatures(cfg, fs, base).map((f) => f.id), ['FR-MAIL-001'])
  })

  test('ratchet accept records a human lowering a threshold', () => {
    const base = git('rev-parse', 'HEAD').trim()
    writeFileSync(join(root, '.cui/features.yaml'), readFileSync(join(root, '.cui/features.yaml'), 'utf8').replace('risk: high', 'risk: high\n    mutation_threshold: 90'))
    git('add', '-A'); git('commit', '-q', '-m', 'raise')
    writeFileSync(join(root, '.cui/features.yaml'), readFileSync(join(root, '.cui/features.yaml'), 'utf8').replace('mutation_threshold: 90', 'mutation_threshold: 70'))
    assert.ok(check(cfg, { base: 'HEAD' }).errors.some((e) => e.rule === 'ratchet'))
    acceptRatchet(cfg, 'HEAD')
    assert.ok(!check(cfg, { base: 'HEAD' }).errors.some((e) => e.rule === 'ratchet'))
    assert.ok(base)
  })
})
