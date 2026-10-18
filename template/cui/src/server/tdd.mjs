import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDocument } from 'yaml'
import * as G from './git.mjs'
import { FILES, ensureResultDirs, loadTestResults, readState } from './registry.mjs'

// Red, then green, recorded. `cui tdd red FR-X` runs the tests and insists the feature's
// tagged tests exist and fail; `cui tdd green FR-X` insists they now all pass — including
// every test that was red. The cycle lands in .cui/tdd/FR-X.json and ships with the commit,
// so the CUI can show that the test came first rather than taking the commit message's word.

// Failures that mean the test never reached an assertion: a red that proves nothing.
const NOT_A_REAL_RED = /SyntaxError|Cannot find module|ERR_MODULE_NOT_FOUND|Failed to load|ModuleNotFoundError|ImportError|is not defined$/i

const now = () => new Date().toISOString()
export const cyclePath = (id) => `.cui/tdd/${id}.json`

export function readCycles(cfg, id, ref = null) {
  const text = ref ? G.fileAtCommit(cfg.root, ref, cyclePath(id))
    : existsSync(join(cfg.root, cyclePath(id))) ? readFileSync(join(cfg.root, cyclePath(id)), 'utf8') : null
  try { return text ? JSON.parse(text) : null } catch { return null }
}

function writeCycles(cfg, id, data) {
  mkdirSync(join(cfg.root, '.cui/tdd'), { recursive: true })
  writeFileSync(join(cfg.root, cyclePath(id)), `${JSON.stringify(data, null, 2)}\n`)
}

export function testCommandFor(cfg, id, override = null) {
  if (override) return override
  // {id_} is for runners that can't match a hyphen, e.g. pytest -k FR_MAIL_002
  if (cfg.feature_test_command) return cfg.feature_test_command.replaceAll('{id_}', id.replaceAll('-', '_')).replaceAll('{id}', id)
  return cfg.test_command
}

/** Runs the command and returns only the results it produced. */
function runAndCollect(cfg, id, cmd) {
  if (!cmd) throw new Error('no test command: set test_command (and ideally feature_test_command) in .cui/config.yaml')
  ensureResultDirs(cfg)
  const started = Date.now() - 1000 // mtime resolution on some filesystems is a full second
  const proc = spawnSync(cmd, { cwd: cfg.root, shell: true, stdio: 'inherit', env: { ...process.env, CUI_FEATURE: id } })
  const results = loadTestResults(cfg, { since: started })
  if (!results.files.length) {
    throw new Error(`"${cmd}" wrote no JUnit results matching ${(cfg.test_results ?? []).join(', ')} — configure the reporter`)
  }
  const tests = results.tests.filter((t) => t.features.includes(id))
  return { exit: proc.status, tests, files: results.files }
}

function findFeature(cfg, id) {
  const f = readState(cfg).features.find((x) => x?.id === id)
  if (!f) throw new Error(`${id} is not in ${FILES.features} — register it (with a test plan) first`)
  if (f.status === 'retired') throw new Error(`${id} is retired`)
  return f
}

const brief = (t) => ({ name: t.name, status: t.status, ...(t.message ? { message: t.message } : {}) })

export function red(cfg, id, { cmd = null } = {}) {
  const feature = findFeature(cfg, id)
  const command = testCommandFor(cfg, id, cmd)
  const { tests } = runAndCollect(cfg, id, command)
  if (!tests.length) throw new Error(`no test tagged [${id}] ran. Put [${id}] in the test or describe name.`)
  const failing = tests.filter((t) => t.status === 'failed')
  if (!failing.length) {
    throw new Error(`all ${tests.length} test(s) for ${id} already pass. A test that passes before the change does not drive it — ` +
      'write one that fails for the behaviour you are about to add.')
  }
  const hollow = failing.filter((t) => NOT_A_REAL_RED.test(t.message ?? ''))
  const warnings = []
  if (hollow.length === failing.length) {
    throw new Error(`every failure for ${id} is a load or syntax error ("${hollow[0].message}"), not an assertion. ` +
      'Stub the interface so the test reaches its assertions, then run red again.')
  }
  if (hollow.length) warnings.push(`${hollow.length} failure(s) are load errors rather than assertions`)
  const already = tests.filter((t) => t.status === 'passed')
  if (already.length) warnings.push(`${already.length} tagged test(s) already pass — they guard existing behaviour, they do not drive this change`)

  const data = readCycles(cfg, id) ?? { feature: id, cycles: [] }
  const last = data.cycles.at(-1)
  const cycle = { red: { at: now(), head: G.git(cfg.root, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFail: true })?.trim() || null, command, tests: tests.map(brief) }, green: null }
  if (last && !last.green) data.cycles[data.cycles.length - 1] = cycle
  else data.cycles.push(cycle)
  writeCycles(cfg, id, data)
  return { feature, failing: failing.length, total: tests.length, warnings }
}

export function green(cfg, id, { cmd = null } = {}) {
  const feature = findFeature(cfg, id)
  const data = readCycles(cfg, id)
  const cycle = data?.cycles.at(-1)
  if (!cycle?.red) throw new Error(`no red recorded for ${id}. Run cui tdd red ${id} before implementing.`)
  if (cycle.green) throw new Error(`the last cycle for ${id} is already green. Start a new one with cui tdd red ${id}.`)

  const command = testCommandFor(cfg, id, cmd)
  const { tests } = runAndCollect(cfg, id, command)
  const failing = tests.filter((t) => t.status === 'failed')
  if (failing.length) throw new Error(`${failing.length} test(s) for ${id} still fail: ${failing[0].name}`)
  const byName = new Map(tests.map((t) => [t.name, t]))
  const lost = cycle.red.tests.filter((t) => t.status === 'failed' && byName.get(t.name)?.status !== 'passed')
  if (lost.length) {
    throw new Error(`${lost.length} test(s) that were red are not passing now (deleted, renamed or skipped?): ${lost[0].name}. ` +
      'Green means the same tests pass — not that the failing ones went away.')
  }

  cycle.green = { at: now(), command, tests: tests.map(brief) }
  writeCycles(cfg, id, data)

  let promoted = false
  if ((feature.status ?? 'planned') === 'planned') {
    const path = join(cfg.root, FILES.features)
    const doc = parseDocument(readFileSync(path, 'utf8'))
    const node = doc.get('features')?.items?.find((n) => n.get?.('id') === id)
    if (node) { node.set('status', 'active'); writeFileSync(path, doc.toString({ lineWidth: 0, flowCollectionPadding: false })); promoted = true }
  }
  const redCount = cycle.red.tests.filter((t) => t.status === 'failed').length
  return { feature, passing: tests.length, red: redCount, promoted, trailer: `Feature: ${id} red→green (${redCount} red, ${tests.length} passing)` }
}

/** Was the latest cycle in this commit's copy of the file completed? */
export function verifiedAt(cfg, id, sha) {
  const c = readCycles(cfg, id, sha)?.cycles.at(-1)
  return Boolean(c?.red && c?.green)
}
