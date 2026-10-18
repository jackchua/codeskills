import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { matchesAny } from './coverage.mjs'
import * as G from './git.mjs'

// Mutation testing for high-risk features. Line coverage says a test *ran* the code; a
// mutation score says the tests would *notice* if the code were wrong. Each high-risk feature
// names the source files it owns; we mutate those, and score the feature on how many mutants
// its project's tests killed.
//
// Input is the mutation-testing-report-schema JSON (https://github.com/stryker-mutator/mutation-testing-elements),
// written by Stryker (JS/TS, .NET, Scala) and other tools that adopted the schema.

export const MUTATION_DIR = '.cui/mutation'
const DETECTED = new Set(['Killed', 'Timeout'])
const UNDETECTED = new Set(['Survived', 'NoCoverage'])

/** Flattens a schema report into one row per mutant, with repo-relative paths. */
export function parseMutationReport(json, root = null) {
  const report = typeof json === 'string' ? JSON.parse(json) : json
  const out = []
  for (const [path, file] of Object.entries(report?.files ?? {})) {
    const rel = root && isAbsolute(path) ? relative(root, path) : path.replace(/^\.\//, '')
    for (const m of file?.mutants ?? []) {
      out.push({
        file: rel,
        line: m.location?.start?.line ?? null,
        mutator: m.mutatorName ?? null,
        replacement: m.replacement ?? null,
        status: m.status,
      })
    }
  }
  return out
}

/** The schema's score: detected / (detected + undetected). Compile and runtime errors don't count. */
export function scoreFor(mutants, globs) {
  const mine = mutants.filter((m) => matchesAny(m.file, globs))
  const killed = mine.filter((m) => DETECTED.has(m.status)).length
  const survived = mine.filter((m) => m.status === 'Survived').length
  const noCoverage = mine.filter((m) => m.status === 'NoCoverage').length
  const valid = killed + survived + noCoverage
  return {
    mutants: mine.length,
    killed, survived, no_coverage: noCoverage, valid,
    score: valid ? Math.round((killed / valid) * 1000) / 10 : null,
    // What a person (or Claude) acts on: "this change to this line went unnoticed".
    survivors: mine.filter((m) => UNDETECTED.has(m.status))
      .sort((a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0))
      .slice(0, 25)
      .map(({ file, line, mutator, replacement, status }) => ({ file, line, mutator, replacement, status })),
  }
}

export const thresholdFor = (cfg, feature) => Number(feature.mutation_threshold ?? cfg.mutation_threshold ?? 60)
export const needsMutation = (f) => f?.risk === 'high' && (f.status ?? 'planned') === 'active'

export function readMutationSummaries(cfg) {
  const dir = join(cfg.root, MUTATION_DIR)
  const out = {}
  if (!existsSync(dir)) return out
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    try { const s = JSON.parse(readFileSync(join(dir, f), 'utf8')); if (s?.feature) out[s.feature] = s } catch { /* ignore */ }
  }
  return out
}

/** Features whose source globs match a file changed between base and HEAD. */
export function changedFeatures(cfg, features, base) {
  const files = (G.git(cfg.root, ['diff', '--name-only', `${base}...HEAD`], { allowFail: true }) ?? '')
    .split('\n').filter(Boolean)
  return features.filter((f) => (f.source ?? []).length && files.some((p) => matchesAny(p, f.source)))
}

/**
 * Runs the configured mutation tool on the selected features' sources, scores each feature,
 * and writes .cui/mutation/<id>.json. Returns the summaries.
 */
export function runMutation(cfg, features, { cmd = null } = {}) {
  const command = cmd ?? cfg.mutation_command
  if (!command) throw new Error('mutation_command is not set in .cui/config.yaml (e.g. "npx stryker run --mutate {files}")')
  const missing = features.filter((f) => !(f.source ?? []).length)
  if (missing.length) throw new Error(`${missing.map((f) => f.id).join(', ')} declare no source: globs, so there is nothing to mutate`)
  if (!features.length) return []

  const globs = [...new Set(features.flatMap((f) => f.source))]
  const reportPath = join(cfg.root, cfg.mutation_report ?? 'reports/mutation/mutation.json')
  // Fresh means rewritten by this run — not merely recent.
  const before = existsSync(reportPath) ? statSync(reportPath).mtimeMs : null
  const proc = spawnSync(command.replaceAll('{files}', globs.join(',')), {
    cwd: cfg.root, shell: true, stdio: 'inherit',
  })
  if (!existsSync(reportPath) || statSync(reportPath).mtimeMs === before) {
    throw new Error(`the mutation command (exit ${proc.status}) wrote no fresh report at ${relative(cfg.root, reportPath)} — ` +
      'enable the tool\'s JSON reporter, or set mutation_report')
  }
  const mutants = parseMutationReport(readFileSync(reportPath, 'utf8'), cfg.root)
  const head = G.git(cfg.root, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFail: true })?.trim() || null
  mkdirSync(join(cfg.root, MUTATION_DIR), { recursive: true })

  return features.map((f) => {
    const summary = {
      feature: f.id, at: new Date().toISOString(), head, source: f.source,
      threshold: thresholdFor(cfg, f), ...scoreFor(mutants, f.source),
    }
    summary.passed = summary.score !== null && summary.score >= summary.threshold
    writeFileSync(join(cfg.root, MUTATION_DIR, `${f.id}.json`), `${JSON.stringify(summary, null, 2)}\n`)
    return summary
  })
}
