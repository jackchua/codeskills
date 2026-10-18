import { createHash } from 'node:crypto'
import { existsSync, globSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { readYamlFile } from './config.mjs'
import * as G from './git.mjs'
import { readMutationSummaries, needsMutation } from './mutation.mjs'

// The feature registry: every feature has an ID, a test plan, and tests tagged with that ID.
// A feature marked active with no passing test fails the check. So does a test tag that
// points nowhere, an exception nobody approved, and any obligation that disappeared since
// the base ref without a matching entry in .cui/approvals.log.

export const FEATURE_TAG = /\[(FR-[A-Z0-9]+(?:-[A-Z0-9]+)*)\]/g
export const FEATURE_STATUSES = new Set(['planned', 'active', 'retired'])
export const EXCEPTION_CATEGORIES = new Set(['manual', 'visual', 'third-party', 'perf', 'flaky', 'other'])

export const FILES = {
  features: '.cui/features.yaml',
  exceptions: '.cui/exceptions.yaml',
  blueprint: '.cui/blueprint.yaml',
  baseline: '.cui/registry-baseline.json',
  approvals: '.cui/approvals.log',
}

export const sha256 = (text) => createHash('sha256').update(text ?? '').digest('hex')

// ------------------------------------------------------------------- junit

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
  return ENTITIES[e] ?? m
})

const attrs = (s) => {
  const out = {}
  for (const m of s.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1]] = decode(m[2] ?? m[3])
  return out
}

export const tagsIn = (text) => [...new Set([...(text ?? '').matchAll(FEATURE_TAG)].map((m) => m[1]))]

/**
 * Parses JUnit XML — the one format every runner can emit (vitest, jest-junit, playwright,
 * pytest --junitxml, node --test-reporter=junit, go-junit-report). Tags are read from the
 * test name, its classname, every enclosing <testsuite> name (node:test puts describe()
 * there), and <property name="feature" value="FR-X"/> (pytest's record_property).
 */
export function parseJUnit(xml, source = null) {
  const tests = []
  const suites = []
  const token = /<(\/?)(testsuites?|testcase)\b([^>]*?)(\/?)>/g
  let m
  while ((m = token.exec(xml))) {
    const [, closing, tag, rawAttrs, selfClosing] = m
    if (tag === 'testsuites') continue
    if (tag === 'testsuite') {
      if (closing) suites.pop()
      else if (!selfClosing) suites.push(attrs(rawAttrs).name ?? '')
      continue
    }
    if (closing) continue
    const a = attrs(rawAttrs)
    let body = ''
    if (!selfClosing) {
      const end = xml.indexOf('</testcase>', token.lastIndex)
      body = end === -1 ? '' : xml.slice(token.lastIndex, end)
      if (end !== -1) token.lastIndex = end + '</testcase>'.length
    }
    const failure = body.match(/<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/)
    const skipped = /<skipped\b/.test(body)
    const props = [...body.matchAll(/<property\b([^>]*?)\/?>/g)].map((p) => attrs(p[1]))
      .filter((p) => /^features?$/i.test(p.name ?? ''))
      .map((p) => p.value ?? '')

    const name = a.name ?? ''
    const classname = a.classname ?? ''
    const features = [...new Set([
      ...tagsIn([...suites, classname, name].join(' ')),
      ...props.flatMap((v) => v.split(/[\s,]+/).filter((id) => /^FR-[A-Z0-9-]+$/.test(id))),
    ])]
    const failAttrs = failure ? attrs(failure[2]) : {}
    tests.push({
      key: `${a.file ?? ''}|${classname}|${[...suites, name].join(' › ')}`,
      name: [...suites.filter(Boolean), name].join(' › ') || classname,
      classname,
      file: a.file ?? null,
      status: failure ? 'failed' : skipped ? 'skipped' : 'passed',
      kind: failure ? failure[1] : null,
      message: failure ? decode(failAttrs.message ?? (failure[3] ?? '').trim().split('\n')[0] ?? '').slice(0, 500) : null,
      time: a.time ? Number(a.time) : null,
      features,
      source,
    })
  }
  return tests
}

/** Some reporters write absolute paths; show them relative to the repo (through symlinks like /tmp). */
function repoPath(cfg, file) {
  if (!isAbsolute(file)) return file
  for (const base of [cfg.root, safeRealpath(cfg.root)]) {
    for (const f of [file, safeRealpath(file)]) {
      const rel = relative(base, f)
      if (!rel.startsWith('..') && !isAbsolute(rel)) return rel
    }
  }
  return file
}
const safeRealpath = (p) => { try { return realpathSync(p) } catch { return p } }

/** Creates the fixed directory part of each test_results pattern — some reporters won't. */
export function ensureResultDirs(cfg) {
  for (const p of cfg.test_results ?? []) {
    const fixed = p.split(/[*?[{]/)[0]
    const dir = fixed.endsWith('/') ? fixed : dirname(fixed)
    if (dir && dir !== '.') mkdirSync(join(cfg.root, dir), { recursive: true })
  }
}

/** Every JUnit file matched by `test_results`, merged. A test seen twice is failed if either run failed. */
export function loadTestResults(cfg, { since = 0, globs = null } = {}) {
  const patterns = globs ?? cfg.test_results ?? []
  const files = [...new Set(patterns.flatMap((p) => globSync(p, { cwd: cfg.root })))]
    .map((f) => join(cfg.root, f))
    .filter((f) => existsSync(f) && statSync(f).isFile() && statSync(f).mtimeMs >= since)
    .sort()
  const byKey = new Map()
  let newest = 0
  for (const file of files) {
    newest = Math.max(newest, statSync(file).mtimeMs)
    for (const t of parseJUnit(readFileSync(file, 'utf8'), relative(cfg.root, file))) {
      if (t.file) t.file = repoPath(cfg, t.file)
      const prev = byKey.get(t.key)
      if (!prev || t.status === 'failed' || (prev.status === 'skipped' && t.status === 'passed')) byKey.set(t.key, t)
    }
  }
  return {
    files: files.map((f) => relative(cfg.root, f)),
    tests: [...byKey.values()],
    at: newest ? new Date(newest).toISOString() : null,
  }
}

// ---------------------------------------------------------------- registry

const parseText = (text) => (text ? parseYaml(text) ?? null : null)

/** Reads the registry files from disk, or — given `ref` — as they stood at that commit. */
export function readState(cfg, ref = null) {
  const read = (rel) => {
    if (ref) return G.fileAtCommit(cfg.root, ref, rel)
    const abs = join(cfg.root, rel)
    return existsSync(abs) ? readFileSync(abs, 'utf8') : null
  }
  const featuresText = read(FILES.features)
  const exceptionsText = read(FILES.exceptions)
  const blueprintText = read(FILES.blueprint)
  const baselineText = read(FILES.baseline)
  const features = parseText(featuresText)
  const exceptions = parseText(exceptionsText)
  const blueprint = parseText(blueprintText)
  let baseline = { features: {} }
  try { baseline = baselineText ? JSON.parse(baselineText) : baseline } catch { /* treated as empty */ }
  return {
    present: featuresText !== null,
    features: features?.features ?? [],
    exceptions: exceptions?.exceptions ?? [],
    blueprint: { locked: blueprint?.locked === true, hash: blueprintText === null ? null : sha256(blueprintText) },
    baseline: baseline.features ?? {},
    // Mutation summaries describe the working tree; at a past ref they aren't needed.
    mutation: ref ? {} : readMutationSummaries(cfg),
  }
}

export function readMilestones(cfg) {
  const pf = readYamlFile(join(cfg.cuiDir, 'product-functions.yaml'))
  return new Map((pf?.milestones ?? []).filter((m) => m?.key).map((m) => [m.key, m]))
}

const todayIso = () => new Date().toISOString().slice(0, 10)
export const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000)

/** Is this exception in force today? Approved, not expired. */
export function exceptionInForce(ex, today = todayIso()) {
  return ex?.status === 'approved' && (!ex.expires || String(ex.expires) >= today)
}

/**
 * Derives each feature's state from the test results and reports every rule it breaks.
 * Pure: give it the registry, the results and the milestones, it gives you the verdict.
 */
export function evaluate({ features, exceptions, mutation = {} }, results, milestones = new Map(), {
  today = todayIso(),
  warnDays = 14,              // exceptions expiring this soon are called out
  mutationThreshold = 60,     // project default; a feature's mutation_threshold overrides
  mutationConfigured = false, // mutation_command set: high-risk features must have been measured
} = {}) {
  const errors = []
  const warnings = []
  const ids = new Set()

  for (const [i, f] of features.entries()) {
    if (!f?.id) { errors.push({ rule: 'schema', message: `feature #${i + 1} has no id` }); continue }
    if (!/^FR-[A-Z0-9]+(-[A-Z0-9]+)*$/.test(f.id)) {
      errors.push({ rule: 'schema', id: f.id, message: `${f.id}: ids look like FR-<AREA>-<NNN>, upper case` })
    }
    if (ids.has(f.id)) errors.push({ rule: 'duplicate', id: f.id, message: `${f.id} is registered twice` })
    ids.add(f.id)
    if (!FEATURE_STATUSES.has(f.status ?? 'planned')) {
      errors.push({ rule: 'schema', id: f.id, message: `${f.id}: status must be planned, active or retired` })
    }
    if (milestones.size && f.milestone && !milestones.has(f.milestone)) {
      errors.push({ rule: 'milestone', id: f.id, message: `${f.id} belongs to unknown milestone ${f.milestone}` })
    }
    if (!f.milestone) warnings.push({ rule: 'milestone', id: f.id, message: `${f.id} is not attached to a milestone` })
    if (!(f.test_plan ?? []).length && f.status !== 'retired') {
      errors.push({ rule: 'plan', id: f.id, message: `${f.id} has no test plan` })
    }
  }

  // exceptions
  const exById = new Map()
  const featureExceptions = new Map() // feature id -> exception excusing the whole feature
  const quarantined = [] // exceptions excusing one named test
  for (const ex of exceptions) {
    if (!ex?.id) { errors.push({ rule: 'schema', message: 'an exception has no id' }); continue }
    exById.set(ex.id, ex)
    if (!ids.has(ex.feature)) {
      errors.push({ rule: 'exception', id: ex.id, message: `${ex.id} refers to unknown feature ${ex.feature}` })
      continue
    }
    if (ex.status === 'rejected') continue
    if (!EXCEPTION_CATEGORIES.has(ex.category)) {
      errors.push({ rule: 'exception', id: ex.id, message: `${ex.id}: category must be one of ${[...EXCEPTION_CATEGORIES].join(', ')}` })
    }
    if (!ex.verification) {
      errors.push({ rule: 'exception', id: ex.id, message: `${ex.id} does not say how ${ex.feature} is verified instead` })
    }
    if (!ex.expires) errors.push({ rule: 'exception', id: ex.id, message: `${ex.id} has no expiry date` })
    if (ex.status !== 'approved') {
      errors.push({ rule: 'approval', id: ex.id, message: `${ex.id} (${ex.feature}) is awaiting your approval — run: cui approve ${ex.id}` })
      continue
    }
    if (!exceptionInForce(ex, today)) {
      errors.push({ rule: 'expired', id: ex.id, message: `${ex.id} (${ex.feature}) expired on ${ex.expires} — test it, or renew the exception` })
      continue
    }
    if (ex.expires && daysBetween(today, String(ex.expires)) <= warnDays) {
      warnings.push({ rule: 'expiring', id: ex.id, message: `${ex.id} (${ex.feature}) expires on ${ex.expires}, in ${daysBetween(today, String(ex.expires))} day(s) — test it or ask for a renewal` })
    }
    if (ex.test) quarantined.push(ex)
    else featureExceptions.set(ex.feature, ex)
  }

  // tests -> features
  const tests = results?.tests ?? []
  const byFeature = new Map()
  const orphans = new Map()
  let untagged = 0
  for (const t of tests) {
    if (!t.features.length) { untagged++; continue }
    for (const id of t.features) {
      if (!ids.has(id)) { orphans.set(id, [...(orphans.get(id) ?? []), t.name]); continue }
      byFeature.set(id, [...(byFeature.get(id) ?? []), t])
    }
  }
  for (const [id, names] of orphans) {
    errors.push({ rule: 'orphan-tag', id, message: `${names.length} test(s) are tagged [${id}], which is not in the registry (e.g. "${names[0]}")` })
  }

  const evaluated = features.filter((f) => f?.id).map((f) => {
    const status = f.status ?? 'planned'
    const ftests = (byFeature.get(f.id) ?? []).map((t) => {
      const q = quarantined.find((ex) => ex.feature === f.id && t.name.includes(ex.test))
      return q && t.status === 'failed' ? { ...t, status: 'quarantined', exception: q.id } : t
    })
    const passing = ftests.filter((t) => t.status === 'passed').length
    const failing = ftests.filter((t) => t.status === 'failed').length
    const ran = ftests.filter((t) => t.status === 'passed' || t.status === 'failed').length
    const exception = featureExceptions.get(f.id) ?? null
    const planCases = (f.test_plan ?? []).length

    let state
    if (status === 'retired') state = 'retired'
    else if (status === 'planned') state = 'planned'
    else if (failing) state = 'failing'
    else if (passing) state = 'passing'
    else if (exception) state = 'excepted'
    else state = 'untested'

    if (state === 'failing') {
      errors.push({ rule: 'failing', id: f.id, message: `${f.id} has ${failing} failing test(s): ${ftests.find((t) => t.status === 'failed').name}` })
    }
    if (state === 'untested') {
      errors.push({ rule: 'untested', id: f.id, message: `${f.id} is active but no passing test is tagged [${f.id}]` })
    }
    if (status === 'planned' && passing && !failing) {
      warnings.push({ rule: 'promote', id: f.id, message: `${f.id} has ${passing} passing test(s) but is still planned — run cui tdd green ${f.id}` })
    }
    if (state === 'passing' && passing < planCases) {
      warnings.push({ rule: 'thin', id: f.id, message: `${f.id}: ${passing} passing test(s) for ${planCases} planned case(s)` })
    }
    // High-risk features: tests must not just run the code, they must catch it being wrong.
    let mut = null
    if (needsMutation({ ...f, status })) {
      const summary = mutation[f.id] ?? null
      const threshold = Number(f.mutation_threshold ?? mutationThreshold)
      mut = summary ? { score: summary.score, threshold, at: summary.at, survived: summary.survived + summary.no_coverage } : { score: null, threshold }
      if (!(f.source ?? []).length) {
        errors.push({ rule: 'mutation', id: f.id, message: `${f.id} is high risk but lists no source: globs, so mutation testing cannot measure it` })
      } else if (!summary) {
        const rule = { rule: 'mutation', id: f.id, message: `${f.id} is high risk and has never been mutation-tested — run cui mutation --feature ${f.id}` }
        mutationConfigured ? errors.push(rule) : warnings.push({ ...rule, message: `${rule.message} (set mutation_command first)` })
      } else if (summary.score === null) {
        errors.push({ rule: 'mutation', id: f.id, message: `${f.id}: the mutation run found no mutants in ${f.source.join(', ')} — check the globs` })
      } else if (summary.score < threshold) {
        errors.push({ rule: 'mutation', id: f.id, message: `${f.id} mutation score ${summary.score}% is below ${threshold}% — ${mut.survived} mutant(s) went unnoticed by the tests` })
      }
    }

    const ms = milestones.get(f.milestone)
    if (ms?.status === 'done' && status === 'planned') {
      errors.push({ rule: 'milestone', id: f.id, message: `${f.milestone} is marked done but ${f.id} is still planned` })
    }
    return {
      ...f, status, state, passing, failing, ran, plan_cases: planCases,
      exception: exception?.id ?? null, tests: ftests, mutation: mut,
    }
  })

  const activeCount = evaluated.filter((f) => f.status === 'active').length
  if (!results?.files?.length) {
    const rule = { rule: 'no-results', message: 'no JUnit test results found — run the tests (see test_results in .cui/config.yaml)' }
    activeCount ? errors.push(rule) : warnings.push(rule)
  }

  const count = (state) => evaluated.filter((f) => f.state === state).length
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    features: evaluated,
    summary: {
      total: evaluated.length,
      passing: count('passing'), failing: count('failing'), untested: count('untested'),
      excepted: count('excepted'), planned: count('planned'), retired: count('retired'),
      exceptions_pending: exceptions.filter((e) => e?.status === 'proposed').length,
      exceptions_expiring: warnings.filter((w) => w.rule === 'expiring').length,
      mutation_failing: errors.filter((e) => e.rule === 'mutation').length,
      tests_total: tests.length, tests_untagged: untagged,
    },
    results_at: results?.at ?? null,
    result_files: results?.files ?? [],
  }
}

// ----------------------------------------------------------------- ratchet

/**
 * The obligations the agent is never allowed to drop on its own. Compares a base state (as
 * committed at the base ref) with the head: what the YAML says now, plus — for test counts —
 * what the test run actually produced, so a deleted or skipped test cannot hide.
 */
export function ratchet(base, head, headEvaluation = null) {
  const items = []
  const headById = new Map(head.features.filter((f) => f?.id).map((f) => [f.id, f]))

  for (const b of base.features) {
    if (!b?.id || b.status === 'retired') continue
    const h = headById.get(b.id)
    if (!h) { items.push({ kind: 'feature-removed', id: b.id }); continue }
    if (h.status === 'retired') items.push({ kind: 'feature-retired', id: b.id })
    else if (b.status === 'active' && (h.status ?? 'planned') !== 'active') items.push({ kind: 'feature-demoted', id: b.id })
    const from = (b.test_plan ?? []).length
    const to = (h.test_plan ?? []).length
    if (h.status !== 'retired' && to < from) items.push({ kind: 'plan-shrunk', id: b.id, from, to })
    if (h.status === 'retired') continue
    if (b.risk === 'high' && h.risk !== 'high') items.push({ kind: 'risk-lowered', id: b.id })
    if (b.mutation_threshold != null && !(Number(h.mutation_threshold) >= Number(b.mutation_threshold))) {
      items.push({ kind: 'threshold-lowered', id: b.id, from: Number(b.mutation_threshold), to: h.mutation_threshold == null ? null : Number(h.mutation_threshold) })
    }
    const dropped = (b.source ?? []).filter((g) => !(h.source ?? []).includes(g))
    if (dropped.length) items.push({ kind: 'source-narrowed', id: b.id, globs: dropped })
  }

  if (headEvaluation) {
    const ran = new Map(headEvaluation.features.map((f) => [f.id, f.ran]))
    for (const [id, rec] of Object.entries(base.baseline ?? {})) {
      const h = headById.get(id)
      if (!h || h.status === 'retired') continue // already reported above
      const now = ran.get(id) ?? 0
      if (now < (rec.tests ?? 0)) items.push({ kind: 'tests-removed', id, from: rec.tests, to: now })
    }
  }

  const baseEx = new Map(base.exceptions.filter((e) => e?.id).map((e) => [e.id, e]))
  for (const e of head.exceptions) {
    if (e?.status !== 'approved') continue
    const b = baseEx.get(e.id)
    if (b?.status === 'approved' && String(b.expires) === String(e.expires) && b.feature === e.feature && (b.test ?? null) === (e.test ?? null)) continue
    items.push({ kind: 'exception-approved', id: e.id, expires: String(e.expires ?? '') })
  }

  if (base.blueprint.locked && head.blueprint.hash !== base.blueprint.hash) {
    items.push({ kind: 'blueprint-changed', id: 'blueprint', hash: head.blueprint.hash })
  }
  return items
}

export const describeItem = (i) => ({
  'feature-removed': `${i.id} was removed from the registry`,
  'feature-retired': `${i.id} was retired`,
  'feature-demoted': `${i.id} went from active back to planned`,
  'plan-shrunk': `${i.id}'s test plan shrank from ${i.from} to ${i.to} case(s)`,
  'tests-removed': `${i.id} ran ${i.to} tagged test(s), down from ${i.from} at the base`,
  'exception-approved': `${i.id} is approved (expires ${i.expires || 'never'})`,
  'blueprint-changed': 'the locked blueprint changed',
  'risk-lowered': `${i.id} is no longer marked high risk`,
  'threshold-lowered': `${i.id}'s mutation threshold went from ${i.from}% to ${i.to == null ? 'the project default' : `${i.to}%`}`,
  'source-narrowed': `${i.id} stopped claiming ${(i.globs ?? []).join(', ')} for mutation testing`,
}[i.kind] ?? `${i.kind} ${i.id}`)

export function readApprovals(cfg, ref = null) {
  const text = ref ? G.fileAtCommit(cfg.root, ref, FILES.approvals)
    : existsSync(join(cfg.root, FILES.approvals)) ? readFileSync(join(cfg.root, FILES.approvals), 'utf8') : null
  return (text ?? '').split('\n').filter((l) => l.trim()).flatMap((l) => {
    try { return [JSON.parse(l)] } catch { return [] }
  })
}

/** An item is covered when some approval explicitly allows it. */
export function isCovered(item, approvals) {
  return approvals.some((a) => (a.allows ?? []).some((al) => {
    if (al.kind !== item.kind || al.id !== item.id) return false
    if (item.kind === 'tests-removed') return (al.to ?? 0) <= item.to
    if (item.kind === 'plan-shrunk') return (al.to ?? 0) <= item.to
    if (item.kind === 'threshold-lowered') return (al.to ?? null) === (item.to ?? null)
    if (item.kind === 'source-narrowed') return (item.globs ?? []).every((g) => (al.globs ?? []).includes(g))
    if (item.kind === 'exception-approved') return String(al.expires ?? '') === item.expires
    if (item.kind === 'blueprint-changed') return al.hash === item.hash
    return true
  }))
}

// ---------------------------------------------------------------- baseline

/**
 * Raises the recorded per-feature test counts to what just ran. Never lowers them: the only
 * way down is an approval (cui approve), which rewrites the entry itself.
 */
export function recordBaseline(cfg, evaluation) {
  const path = join(cfg.root, FILES.baseline)
  let current = { version: 1, features: {} }
  try { if (existsSync(path)) current = JSON.parse(readFileSync(path, 'utf8')) } catch { /* rebuild */ }
  const next = { version: 1, features: { ...current.features } }
  let raised = 0
  for (const f of evaluation.features) {
    if (f.status === 'retired') { delete next.features[f.id]; continue }
    if (f.status !== 'active' || f.state === 'failing') continue
    const prev = next.features[f.id]?.tests ?? 0
    if (f.ran > prev) { next.features[f.id] = { tests: f.ran }; raised++ }
  }
  next.features = Object.fromEntries(Object.entries(next.features).sort(([a], [b]) => a.localeCompare(b)))
  const text = `${JSON.stringify(next, null, 2)}\n`
  const before = existsSync(path) ? readFileSync(path, 'utf8') : null
  if (text !== before) writeFileSync(path, text)
  return { raised, changed: text !== before }
}

// -------------------------------------------------------------------- check

export const evaluateOptions = (cfg) => ({
  warnDays: Number(cfg.exception_warning_days ?? 14),
  mutationThreshold: Number(cfg.mutation_threshold ?? 60),
  mutationConfigured: Boolean(cfg.mutation_command),
})

/** Everything CI runs, in one call: evaluate, and — with a base ref — the ratchet. */
export function check(cfg, { base = null, results = null } = {}) {
  const head = readState(cfg)
  const res = results ?? loadTestResults(cfg)
  const evaluation = evaluate(head, res, readMilestones(cfg), evaluateOptions(cfg))

  let ratchetReport = null
  if (base) {
    const baseSha = G.git(cfg.root, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`], { allowFail: true })?.trim()
    if (!baseSha) {
      evaluation.warnings.push({ rule: 'ratchet', message: `base ref ${base} does not resolve — ratchet skipped` })
    } else {
      const baseState = readState(cfg, baseSha)
      const approvals = readApprovals(cfg)
      const items = ratchet(baseState, head, evaluation).map((i) => ({ ...i, covered: isCovered(i, approvals), text: describeItem(i) }))
      for (const i of items.filter((x) => !x.covered)) {
        evaluation.errors.push({ rule: 'ratchet', id: i.id, message: `${i.text} without your approval (see .cui/approvals.log)` })
      }
      ratchetReport = { base: baseSha, items }
      evaluation.ok = evaluation.errors.length === 0
    }
  }
  return { ...evaluation, ratchet: ratchetReport }
}
