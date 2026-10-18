#!/usr/bin/env node
import { execSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { findRoot, loadConfig, ensureDirs } from '../src/server/config.mjs'
import { openDb, all, get, run } from '../src/server/db.mjs'
import { sync } from '../src/server/sync.mjs'
import { ingestCommit, backfill, scanDemoDir } from '../src/server/ingest.mjs'
import { startServer } from '../src/server/index.mjs'
import * as G from '../src/server/git.mjs'
import { loadCoverage, projectTotals, diffTotals, findCoverageFile } from '../src/server/coverage.mjs'
import { claudeAvailable } from '../src/server/claude.mjs'
import { check, recordBaseline, readState, describeItem, ensureResultDirs } from '../src/server/registry.mjs'
import { approve, reject, pendingApprovals, createProposal, acceptRatchet } from '../src/server/approvals.mjs'
import * as TDD from '../src/server/tdd.mjs'
import { runMutation, changedFeatures, needsMutation } from '../src/server/mutation.mjs'
import { daysBetween, exceptionInForce } from '../src/server/registry.mjs'
import { appendFileSync } from 'node:fs'

// ------------------------------------------------------------------ plumbing

const C = process.stdout.isTTY
  ? { dim: (s) => `\x1b[2m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m`,
      g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`,
      y: (s) => `\x1b[33m${s}\x1b[0m`, c: (s) => `\x1b[36m${s}\x1b[0m` }
  : new Proxy({}, { get: () => (s) => s })

function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=')
      if (inline !== undefined) flags[k] = inline
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[k] = argv[++i]
      else flags[k] = true
    } else positional.push(a)
  }
  return { positional, flags }
}

const die = (msg) => { console.error(C.r(`cui: ${msg}`)); process.exit(1) }
const ok = (msg) => console.log(`${C.g('✓')} ${msg}`)
const warn = (msg) => console.log(`${C.y('!')} ${msg}`)
const pctStr = (v) => (v === null || v === undefined ? C.dim('n/a') : `${v}%`)

function context() {
  const cfg = loadConfig(findRoot())
  ensureDirs(cfg)
  return { cfg, db: openDb(cfg) }
}

// ------------------------------------------------------------------ commands

const commands = {}

commands.init = () => {
  const root = findRoot()
  const cuiDir = join(root, '.cui')
  mkdirSync(cuiDir, { recursive: true })
  const write = (name, body) => {
    const path = join(cuiDir, name)
    if (existsSync(path)) { warn(`${relative(root, path)} exists, left alone`); return }
    writeFileSync(path, body)
    ok(`wrote ${relative(root, path)}`)
  }
  write('.gitignore', `# The database is a projection of the YAML files and git history.
# Rebuild it with: cui sync && cui backfill
cui.db
cui.db-wal
cui.db-shm
`)
  write('config.yaml', `# CUI configuration
enforce: true            # gate implementation writes on milestones + locked blueprint
port: 4317
test_command: null       # e.g. "npm test" — must write JUnit XML to one of test_results
coverage_command: null   # e.g. "npm test -- --coverage"
feature_test_command: null  # one feature's tests, {id} substituted, e.g. "npx vitest run -t '\\[{id}\\]'"
test_results:            # JUnit XML the feature registry reads
  - "test-results/**/*.xml"
mutation_command: null   # risk: high features, {files} = their source globs, e.g. "npx stryker run --mutate {files}"
mutation_threshold: 60   # minimum mutation score (%) for a high-risk feature
exception_warning_days: 14
diff_coverage_threshold: 80
claude_bin: claude
ignore_paths:
  - "node_modules/**"
  - "dist/**"
  - "build/**"
  - "cui/**"
  - "demos/**"
  - ".cui/**"
`)
  const { cfg, db } = context()
  sync(db, cfg)
  ok('database initialised at .cui/cui.db')
  commands['install-hooks']()
  console.log(`\nNext: run ${C.c('/cui:pf')} in Claude Code to define Product Function milestones.`)
}

commands['install-hooks'] = () => {
  const root = findRoot()
  const hookDir = join(root, '.git', 'hooks')
  if (!existsSync(hookDir)) return warn('no .git/hooks — is this a git repo? skipping git hook')
  const path = join(hookDir, 'post-commit')
  const body = `#!/bin/sh
# Installed by cui — records every commit in the Central UI.
# Runs detached so it never slows down a commit.
ROOT=$(git rev-parse --show-toplevel)
if [ -f "$ROOT/cui/bin/cui.mjs" ]; then
  ( node "$ROOT/cui/bin/cui.mjs" ingest --sha "$(git rev-parse HEAD)" --quiet >/dev/null 2>&1 & )
fi
exit 0
`
  if (existsSync(path) && !readFileSync(path, 'utf8').includes('Installed by cui')) {
    warn(`.git/hooks/post-commit exists and is not ours — add this line yourself:`)
    console.log(C.dim(`    node "$(git rev-parse --show-toplevel)/cui/bin/cui.mjs" ingest --sha "$(git rev-parse HEAD)" &`))
    return
  }
  writeFileSync(path, body)
  chmodSync(path, 0o755)
  ok('installed .git/hooks/post-commit')
}

commands.sync = () => {
  const { cfg, db } = context()
  const r = sync(db, cfg)
  ok(`synced ${r.milestones} milestones, ${r.criteria} criteria, ${r.layout} dirs, ` +
     `${r.entrypoints} entry points, ${r.commands} commands`)
  for (const w of r.warnings) warn(w)
}

commands.serve = (args) => {
  const { cfg } = context()
  if (args.flags.port) cfg.port = Number(args.flags.port)
  startServer(cfg, { dev: args.flags.dev === true, open: args.flags.open === true })
}
commands.start = commands.serve

commands.ingest = (args) => {
  const { cfg, db } = context()
  if (!G.isRepo(cfg.root)) die('not a git repository')
  const r = ingestCommit(db, cfg, args.flags.sha ?? 'HEAD')
  if (args.flags.quiet) return
  ok(`ingested ${C.b(r.short_sha)} ${r.subject}`)
  if (r.coverage?.project) {
    console.log(`  coverage  project ${pctStr(r.coverage.project.pct)}  ` +
                `diff ${pctStr(r.coverage.diff.pct)} (${r.coverage.diff.covered}/${r.coverage.diff.total} added lines)`)
    const threshold = cfg.diff_coverage_threshold
    if (r.coverage.diff.total > 0 && r.coverage.diff.pct < threshold) {
      warn(`diff coverage ${r.coverage.diff.pct}% is below the ${threshold}% threshold`)
    }
  } else if (r.coverage?.error) warn(`coverage: ${r.coverage.error}`)
  else warn('no coverage artifact found — run your tests with coverage before committing')

  for (const m of r.milestones) console.log(`  PF        ${m.key ?? 'none'} ${m.impact}`)
  for (const k of r.unknownKeys) warn(`commit references unknown milestone ${k}`)
  if (r.demo?.dir) console.log(`  demo      ${r.demo.dir} (${r.demo.artifacts} artifacts)`)
  else if (r.demo?.status === 'skipped') console.log(`  demo      skipped — ${r.demo.reason}`)
  else if (r.demo?.status === 'waived') console.log(`  demo      waived by you${r.demo.reason ? ` — ${r.demo.reason}` : ''}`)
  else warn('no demo recorded for this commit')
  if (r.unparsed) warn('no CUI trailers found — commit via the ship-commit skill (/cui:ship)')
}

commands.backfill = (args) => {
  const { cfg, db } = context()
  const results = backfill(db, cfg, { limit: Number(args.flags.limit ?? 200) })
  const failed = results.filter((r) => r.error)
  ok(`backfilled ${results.length - failed.length} commits`)
  for (const f of failed) warn(`${f.sha?.slice(0, 7)}: ${f.error}`)
}

commands.status = (args) => {
  const { cfg, db } = context()
  const brief = args.flags.brief === true
  const only = args.flags.milestone

  const meta = Object.fromEntries(all(db, `select key, value from meta`).map((r) => [r.key, r.value]))
  const ms = all(db, `
    select m.*,
      (select count(*) from criteria where milestone_key = m.key) t,
      (select count(*) from criteria where milestone_key = m.key and status='met') met,
      (select count(*) from commit_milestones where milestone_key = m.key) commits
    from milestones m ${only ? 'where m.key = ?' : ''} order by m.position`, only ? [only] : [])

  if (!ms.length) {
    console.log(C.y('No Product Function milestones defined. Run /cui:pf in Claude Code.'))
    return
  }

  if (!brief && meta.product) console.log(`${C.b(meta.product)} — ${meta.north_star ?? ''}\n`)

  for (const m of ms) {
    const bar = m.t ? progressBar(m.met / m.t) : C.dim('no criteria')
    const mark = m.status === 'done' ? C.g('●') : m.status === 'in_progress' ? C.y('◐')
      : m.status === 'dropped' ? C.dim('○') : C.dim('○')
    console.log(`${mark} ${C.b(m.key.padEnd(7))} ${bar} ${String(m.met).padStart(2)}/${m.t}  ${m.title}`)
    if (!brief && m.commits) console.log(`  ${C.dim(`${m.commits} commit(s)`)}`)
  }

  if (brief) return

  const cov = get(db, `select cov.project_pct, cov.diff_pct, c.short_sha from coverage cov
                       join commits c on c.sha = cov.sha order by c.committed_at desc limit 1`)
  const health = {
    commits: get(db, `select count(*) n from commits`).n,
    owed: get(db, `select count(*) n from demos where required=1 and status='missing'`).n,
    unparsed: get(db, `select count(*) n from commits where unparsed=1`).n,
    walk: get(db, `select count(*) n from walkthroughs where status='ready'`).n,
  }
  console.log()
  console.log(`  blueprint   ${meta.blueprint_locked === '1' ? C.g('locked') : C.r('NOT LOCKED')}`)
  console.log(`  commits     ${health.commits}${health.unparsed ? C.y(`  (${health.unparsed} without CUI trailers)`) : ''}`)
  console.log(`  coverage    ${cov ? `project ${pctStr(cov.project_pct)}  last diff ${pctStr(cov.diff_pct)}` : C.dim('none recorded')}`)
  console.log(`  demos owed  ${health.owed ? C.y(String(health.owed)) : C.g('0')}`)
  console.log(`  walkthrough ${health.walk} generated`)
  const reg = check(cfg)
  if (reg.summary.total) {
    const s = reg.summary
    console.log(`  features    ${C.g(`${s.passing} passing`)}  ${s.failing + s.untested ? C.r(`${s.failing + s.untested} broken`) : '0 broken'}  ` +
                `${s.planned} planned  ${s.excepted} excepted  ${reg.ok ? C.g('check ok') : C.r(`${reg.errors.length} error(s)`)}`)
  }
  const pending = pendingApprovals(cfg)
  const waiting = pending.proposals.length + pending.exceptions.length
  if (waiting) console.log(`  approvals   ${C.y(`${waiting} waiting on you`)} — cui approvals`)
  const expiring = reg.warnings.filter((w) => w.rule === 'expiring')
  for (const w of expiring) console.log(`  exceptions  ${C.y(w.message)}`)
  console.log(`\n  ${C.dim(`dashboard: http://localhost:${cfg.port}`)}`)
}

const progressBar = (frac) => {
  const w = 12
  const filled = Math.round(frac * w)
  return C.g('█'.repeat(filled)) + C.dim('░'.repeat(w - filled))
}

commands.doctor = (args) => {
  const { cfg, db } = context()
  let problems = 0
  const fail = (m) => { problems++; console.log(`${C.r('✗')} ${m}`) }

  if (!G.isRepo(cfg.root)) fail('not a git repository — run `git init`')
  else ok('git repository')

  const pf = all(db, `select key from milestones where status != 'dropped'`)
  pf.length ? ok(`${pf.length} Product Function milestones defined`)
            : fail('no milestones — run /cui:pf')

  const locked = get(db, `select value from meta where key='blueprint_locked'`)?.value === '1'
  locked ? ok('blueprint locked') : fail('blueprint not locked — run /cui:blueprint')

  const hookPath = join(cfg.root, '.git/hooks/post-commit')
  existsSync(hookPath) && readFileSync(hookPath, 'utf8').includes('Installed by cui')
    ? ok('git post-commit hook installed')
    : fail('post-commit hook missing — run `cui install-hooks`')

  const covFile = findCoverageFile(cfg)
  covFile ? ok(`coverage artifact: ${relative(cfg.root, covFile)}`)
          : warn('no coverage artifact found — run your test suite with coverage on')

  // Entry points and commands must point at things that exist.
  for (const e of all(db, `select * from entrypoints`)) {
    if (e.path && !existsSync(join(cfg.root, e.path))) {
      warn(`entrypoint ${e.id}: ${e.path} does not exist yet (planned)`)
    }
  }
  const cmdCount = get(db, `select count(*) n from commands`).n
  cmdCount ? ok(`${cmdCount} commands catalogued`) : warn('no commands in .cui/commands.yaml')

  // Every entrypoint command should be discoverable in the command catalogue.
  const catalogued = new Set(all(db, `select command from commands`).map((r) => r.command))
  for (const e of all(db, `select id, command from entrypoints where command is not null`)) {
    if (!catalogued.has(e.command)) warn(`entrypoint "${e.id}" command is not in commands.yaml: ${e.command}`)
  }

  const reg = readState(cfg)
  reg.present ? ok(`feature registry: ${reg.features.length} feature(s)`)
              : warn('no .cui/features.yaml — run /cui:features to build the registry')
  if (!cfg.test_command) warn('test_command is not set in .cui/config.yaml — cui test, cui tdd and CI need it')
  existsSync(join(cfg.root, '.github/workflows/cui.yml'))
    ? ok('CI workflow .github/workflows/cui.yml')
    : warn('no .github/workflows/cui.yml — nothing enforces the registry outside this machine')

  const owed = all(db, `select d.sha, c.short_sha, c.subject from demos d join commits c on c.sha=d.sha
                        where d.required=1 and d.status='missing' order by c.committed_at desc limit 5`)
  for (const d of owed) warn(`${d.short_sha} looks like it owes a demo: ${d.subject}`)

  if (args.flags.preflight) {
    if (!G.isDirty(cfg.root)) fail('nothing staged or modified — nothing to commit')
    if (problems) { console.log(); die('preflight failed') }
  }

  console.log()
  problems ? die(`${problems} problem(s)`) : ok('all checks passed')
}

commands.coverage = (args) => {
  const { cfg, db } = context()
  const sub = args.positional[0] ?? 'report'

  if (sub === 'run') {
    const cmd = cfg.coverage_command ??
      get(db, `select command from commands where category='test' order by position limit 1`)?.command
    if (!cmd) die('no coverage_command in .cui/config.yaml and no test command in .cui/commands.yaml')
    console.log(C.dim(`$ ${cmd}`))
    try { execSync(cmd, { cwd: cfg.root, stdio: 'inherit' }) }
    catch { die('test command failed — fix the tests before committing') }
  }

  const cov = loadCoverage(cfg)
  if (!cov) die(`no coverage artifact found. Looked for:\n  ${cfg.coverage_files.join('\n  ')}`)
  const project = projectTotals(cov)
  console.log(`\n  tool      ${cov.tool}  (${cov.file})`)
  console.log(`  project   ${pctStr(project.pct)}  ${project.covered}/${project.total} lines`)

  if (G.isRepo(cfg.root)) {
    const sha = G.resolveSha(cfg.root, args.flags.sha ?? 'HEAD')
    const diff = diffTotals(cov, G.addedLines(cfg.root, sha))
    console.log(`  diff      ${pctStr(diff.pct)}  ${diff.covered}/${diff.total} added lines (${sha.slice(0, 7)})`)
    const worst = [...diff.perFile.entries()].filter(([, v]) => v.pct < 100)
      .sort((a, b) => a[1].pct - b[1].pct).slice(0, 8)
    if (worst.length) {
      console.log(`\n  ${C.dim('least-covered new code:')}`)
      for (const [path, v] of worst) {
        console.log(`    ${String(v.pct).padStart(5)}%  ${v.covered}/${v.total}  ${path}`)
      }
    }
    if (diff.total && diff.pct < cfg.diff_coverage_threshold) {
      console.log()
      warn(`diff coverage ${diff.pct}% is below the ${cfg.diff_coverage_threshold}% threshold`)
    }
  }
  console.log()
}

commands.demo = (args) => {
  const { cfg, db } = context()
  const sub = args.positional[0]
  const sha = G.resolveSha(cfg.root, args.flags.sha ?? 'HEAD')

  if (sub === 'register') {
    const dir = args.flags.dir ?? `demos/${sha.slice(0, 7)}`
    const scan = scanDemoDir(cfg.root, dir)
    if (!scan) die(`no such directory: ${dir}`)
    if (!scan.artifacts.length) die(`${dir} is empty`)
    if (!scan.hasRunScript) warn(`${dir} has no run.sh — a demo you cannot re-run is a claim, not evidence`)
    if (!scan.artifacts.some((a) => a.name === 'demo.md')) warn(`${dir} has no demo.md narrative`)
    run(db, `insert into demos(sha, required, status, dir, title, claim, artifacts, registered_at)
             values(?,1,'present',?,?,?,?,?)
             on conflict(sha) do update set required=1, status='present', dir=excluded.dir,
               title=excluded.title, claim=excluded.claim, artifacts=excluded.artifacts,
               reason=null, registered_at=excluded.registered_at`,
      [sha, dir, scan.title, scan.claim, scan.artifacts, new Date().toISOString()])
    ok(`registered ${dir} (${scan.artifacts.length} artifacts) for ${sha.slice(0, 7)}`)
    return
  }

  if (sub === 'skip') {
    const reason = args.flags.reason
    if (!reason || reason === true) die('--reason is required, and "trivial" is not a reason')
    if (String(reason).split(/\s+/).length < 3) die('give a reason someone could argue with')
    run(db, `insert into demos(sha, required, status, reason, registered_at) values(?,0,'skipped',?,?)
             on conflict(sha) do update set required=0, status='skipped', reason=excluded.reason`,
      [sha, reason, new Date().toISOString()])
    ok(`recorded demo skip for ${sha.slice(0, 7)}: ${reason}`)
    return
  }

  if (sub === 'waive') {
    const note = args.flags.note && args.flags.note !== true ? args.flags.note : null
    run(db, `insert into demos(sha, required, status, reason, registered_at) values(?,0,'waived',?,?)
             on conflict(sha) do update set required=0, status='waived', reason=excluded.reason`,
      [sha, note, new Date().toISOString()])
    ok(`recorded ${sha.slice(0, 7)} as shipped without a demo, by choice`)
    return
  }

  if (sub === 'list' || !sub) {
    for (const d of all(db, `select d.*, c.short_sha, c.subject from demos d join commits c on c.sha=d.sha
                             order by c.committed_at desc limit 30`)) {
      const mark = d.status === 'present' ? C.g('●') : d.status === 'waived' ? C.dim('w') : d.required ? C.r('○') : C.dim('—')
      console.log(`${mark} ${d.short_sha}  ${(d.dir ?? d.reason ?? '').slice(0, 50).padEnd(50)} ${C.dim(d.subject ?? '')}`)
    }
    return
  }
  die(`unknown: cui demo ${sub}`)
}

commands.walkthrough = async (args) => {
  const { cfg, db } = context()
  const sub = args.positional[0] ?? 'list'
  const sha = args.flags.sha ? G.resolveSha(cfg.root, args.flags.sha) : G.resolveSha(cfg.root, 'HEAD')

  if (sub === 'register') {
    const file = args.flags.file
    if (!file || file === true) die('--file is required')
    const markdown = readFileSync(resolve(cfg.root, file), 'utf8')
    run(db, `insert into walkthroughs(sha, status, markdown, finished_at) values(?,'ready',?,?)
             on conflict(sha) do update set status='ready', markdown=excluded.markdown,
               error=null, finished_at=excluded.finished_at`,
      [sha, markdown, new Date().toISOString()])
    ok(`registered walkthrough for ${sha.slice(0, 7)} (${markdown.length} chars)`)
    return
  }

  if (sub === 'generate') {
    if (!(await claudeAvailable(cfg))) die(`"${cfg.claude_bin}" is not on PATH`)
    const { startWalkthrough } = await import('../src/server/jobs.mjs')
    startWalkthrough(db, cfg, sha, { force: args.flags.force === true })
    console.log(`Generating walkthrough for ${sha.slice(0, 7)}…`)
    for (;;) {
      await new Promise((r) => setTimeout(r, 1500))
      const row = get(db, `select status, error from walkthroughs where sha = ?`, [sha])
      if (row?.status === 'ready') { ok(`written to .cui/walkthroughs/${sha.slice(0, 7)}.md`); return }
      if (row?.status === 'error') die(row.error)
    }
  }

  for (const w of all(db, `select w.sha, w.status, c.short_sha, c.subject from walkthroughs w
                           join commits c on c.sha = w.sha order by c.committed_at desc limit 30`)) {
    console.log(`${w.status === 'ready' ? C.g('●') : C.y('◐')} ${w.short_sha}  ${w.subject}`)
  }
}

// ------------------------------------------------------------------ registry

function printCheck(r, { verbose = true } = {}) {
  const s = r.summary
  console.log(`\n  features  ${s.total} registered: ${C.g(`${s.passing} passing`)}, ` +
              `${s.failing ? C.r(`${s.failing} failing`) : '0 failing'}, ` +
              `${s.untested ? C.r(`${s.untested} untested`) : '0 untested'}, ` +
              `${s.excepted} excepted, ${s.planned} planned, ${s.retired} retired`)
  console.log(`  tests     ${s.tests_total} ran, ${s.tests_untagged} untagged` +
              (r.result_files.length ? C.dim(`  (${r.result_files.length} result file(s), ${r.results_at})`) : ''))
  if (r.ratchet) {
    const covered = r.ratchet.items.filter((i) => i.covered)
    console.log(`  ratchet   vs ${r.ratchet.base.slice(0, 7)}: ${r.ratchet.items.length} obligation change(s), ${covered.length} approved`)
    if (verbose) for (const i of covered) console.log(`            ${C.g('✓')} ${i.text}`)
  }
  if (r.warnings.length && verbose) {
    console.log()
    for (const w of r.warnings) warn(w.message)
  }
  if (r.errors.length) {
    console.log()
    for (const e of r.errors) console.log(`${C.r('✗')} ${e.message}`)
  }
  console.log()
}

commands.registry = (args) => {
  const { cfg } = context()
  const sub = args.positional[0] ?? 'check'
  const base = args.flags.base && args.flags.base !== true ? args.flags.base : null

  if (sub === 'list') {
    const r = check(cfg)
    const mark = { passing: C.g('●'), failing: C.r('✗'), untested: C.r('○'), excepted: C.y('◇'), planned: C.dim('○'), retired: C.dim('—') }
    let ms = null
    for (const f of [...r.features].sort((a, b) => String(a.milestone).localeCompare(String(b.milestone)))) {
      if (f.milestone !== ms) { ms = f.milestone; console.log(`\n${C.b(ms ?? '(no milestone)')}`) }
      const counts = f.status === 'active' ? `${f.passing}/${f.ran}`.padStart(5) : '     '
      console.log(`  ${mark[f.state]} ${f.id.padEnd(16)} ${counts}  ${f.title ?? ''}${f.exception ? C.y(`  [${f.exception}]`) : ''}`)
    }
    console.log()
    return
  }

  if (sub === 'check') {
    const r = check(cfg, { base })
    if (args.flags.json) { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1) }
    printCheck(r)
    if (args.flags.record) {
      if (!r.ok) die('not recording a baseline from a failing check')
      const b = recordBaseline(cfg, r)
      b.changed ? ok(`baseline raised for ${b.raised} feature(s) — commit .cui/registry-baseline.json`) : ok('baseline unchanged')
    }
    r.ok ? ok('registry check passed') : die(`registry check failed: ${r.errors.length} error(s)`)
    return
  }
  die(`unknown: cui registry ${sub}`)
}

// Everything CI enforces. Run the tests first (cui test), then this.
commands.ci = (args) => {
  const { cfg, db } = context()
  sync(db, cfg)
  let failed = 0
  const fail = (m) => { failed++; console.log(`${C.r('✗')} ${m}`) }
  get(db, `select count(*) n from milestones where status != 'dropped'`).n ? ok('milestones defined') : fail('no Product Function milestones')
  getMetaLocked(db) ? ok('blueprint locked') : fail('blueprint is not locked')
  const base = args.flags.base && args.flags.base !== true ? args.flags.base : null
  if (!base) warn('no --base given: the ratchet (removed features, tests and exceptions) is not checked')
  const r = check(cfg, { base })
  printCheck(r)
  if (!r.ok) fail(`registry: ${r.errors.length} error(s)`)
  failed ? die(`ci failed: ${failed} problem(s)`) : ok('ci passed')
}

const getMetaLocked = (db) => get(db, `select value from meta where key='blueprint_locked'`)?.value === '1'

commands.test = () => {
  const { cfg } = context()
  if (!cfg.test_command) die('test_command is not set in .cui/config.yaml')
  ensureResultDirs(cfg)
  console.log(C.dim(`$ ${cfg.test_command}`))
  try { execSync(cfg.test_command, { cwd: cfg.root, stdio: 'inherit' }) }
  catch (err) { process.exit(err.status ?? 1) }
}

commands.tdd = (args) => {
  const { cfg } = context()
  const [phase, id] = args.positional
  if (!['red', 'green', 'status'].includes(phase) || !id) die('usage: cui tdd red|green|status FR-XXX-NNN [--cmd "..."]')
  const cmd = args.flags.cmd && args.flags.cmd !== true ? args.flags.cmd : null

  if (phase === 'status') {
    const data = TDD.readCycles(cfg, id)
    if (!data?.cycles.length) return console.log(`${id}: no cycles recorded`)
    for (const [i, c] of data.cycles.entries()) {
      const r = c.red.tests.filter((t) => t.status === 'failed').length
      console.log(`  cycle ${i + 1}  red ${c.red.at} (${r} failing)  ${c.green ? C.g(`green ${c.green.at}`) : C.y('not green yet')}`)
    }
    return
  }

  if (phase === 'red') {
    const r = TDD.red(cfg, id, { cmd })
    console.log()
    for (const w of r.warnings) warn(w)
    ok(`${id} is red: ${r.failing} of ${r.total} tagged test(s) fail. Read each failure message — ` +
       'it should fail because the behaviour is missing, not because the test is broken. Now implement.')
    return
  }

  const r = TDD.green(cfg, id, { cmd })
  console.log()
  ok(`${id} is green: ${r.passing} tagged test(s) pass, including all ${r.red} that were red`)
  if (r.promoted) ok(`${id} promoted planned → active in .cui/features.yaml`)
  console.log(`\n  Run the full suite next (cui test), then ship with this trailer:\n  ${C.c(r.trailer)}\n`)
}

// ----------------------------------------------------------------- approvals

commands.approvals = () => {
  const { cfg } = context()
  const { proposals, exceptions } = pendingApprovals(cfg)
  if (!proposals.length && !exceptions.length) return ok('nothing waiting on you')
  for (const p of proposals) {
    console.log(`${C.y('◆')} ${C.b(p.id)}  ${p.title ?? ''}${p.stale ? C.r('  (stale: target changed since)') : ''}`)
    console.log(`    ${p.kind === 'file' ? `replaces ${p.target}` : `lets ${p.feature} drop to ${p.min} test(s)`}`)
    console.log(`    ${C.dim(p.why ?? '')}`)
  }
  for (const e of exceptions) {
    console.log(`${C.y('◇')} ${C.b(e.id)}  exception for ${e.feature} (${e.category}, expires ${e.expires})`)
    console.log(`    ${C.dim(e.reason ?? '')}`)
    console.log(`    ${C.dim(`verified instead by: ${e.verification ?? '—'}`)}`)
  }
  console.log(`\n  ${C.dim('cui approve <id> [--note "..."]   cui reject <id> [--note "..."]   or use the Approvals page')}\n`)
}

commands.approve = (args) => {
  const { cfg, db } = context()
  const id = args.positional[0]
  if (!id) die('usage: cui approve <proposal-or-exception-id> [--note "..."]')
  const note = args.flags.note && args.flags.note !== true ? args.flags.note : null
  const r = approve(cfg, id, { note })
  sync(db, cfg)
  ok(`approved ${id}${r.target ? ` — wrote ${r.target}` : ''}`)
  for (const a of r.allows) console.log(`  ${C.dim('allows')} ${describeItem({ ...a, from: '?' })}`)
  console.log(C.dim('  recorded in .cui/approvals.log — commit it with the change'))
}

commands.reject = (args) => {
  const { cfg } = context()
  const id = args.positional[0]
  if (!id) die('usage: cui reject <id> [--note "..."]')
  reject(cfg, id, { note: args.flags.note && args.flags.note !== true ? args.flags.note : null })
  ok(`rejected ${id}`)
}

commands.propose = (args) => {
  const { cfg } = context()
  const kind = args.positional[0]
  const flag = (k) => (args.flags[k] && args.flags[k] !== true ? args.flags[k] : undefined)
  const p = { title: flag('title'), why: flag('why'), id: flag('id') }
  if (kind === 'file') {
    if (!flag('target') || !flag('from')) die('usage: cui propose file --target .cui/blueprint.yaml --from <draft> --title "..." --why "..."')
    Object.assign(p, { kind: 'file', target: flag('target'), content: readFileSync(resolve(cfg.root, flag('from')), 'utf8') })
  } else if (kind === 'tests') {
    if (!flag('feature') || flag('min') === undefined) die('usage: cui propose tests --feature FR-X --min N --title "..." --why "..."')
    Object.assign(p, { kind: 'tests', feature: flag('feature'), min: Number(flag('min')) })
  } else die('usage: cui propose file|tests ...')
  if (!p.title) die('--title is required')
  const r = createProposal(cfg, p)
  ok(`wrote ${r.file}. It does nothing until a human approves it: cui approve ${r.id}, or the CUI Approvals page.`)
}

commands.ratchet = (args) => {
  const { cfg } = context()
  const sub = args.positional[0]
  const base = args.flags.base && args.flags.base !== true ? args.flags.base : null
  if (sub !== 'accept' || !base) die('usage: cui ratchet accept --base <ref> [--note "..."]  (records approval for changes you made by hand)')
  const r = acceptRatchet(cfg, base, { note: args.flags.note && args.flags.note !== true ? args.flags.note : null })
  if (!r.items.length) return ok('nothing to accept')
  for (const i of r.items) ok(`approved: ${i.text}`)
}

// ------------------------------------------------------------------ mutation

commands.mutation = (args) => {
  const { cfg } = context()
  const features = readState(cfg).features.filter((f) => f?.id)
  const flag = (k) => (args.flags[k] && args.flags[k] !== true ? args.flags[k] : null)
  let selected
  if (flag('feature')) {
    const ids = flag('feature').split(',')
    selected = features.filter((f) => ids.includes(f.id))
    const unknown = ids.filter((id) => !selected.some((f) => f.id === id))
    if (unknown.length) die(`not in the registry: ${unknown.join(', ')}`)
  } else if (flag('base')) {
    // CI on a pull request: only high-risk features whose source this branch touched.
    selected = changedFeatures(cfg, features.filter(needsMutation), flag('base'))
    if (!cfg.mutation_command) return ok('mutation_command not set — skipping mutation testing')
    if (!selected.length) return ok('no high-risk feature source changed — nothing to mutate')
  } else {
    selected = features.filter(needsMutation)
    if (!selected.length) return ok('no active risk: high features — nothing to mutate')
  }
  console.log(C.dim(`mutating ${selected.length} feature(s): ${selected.map((f) => f.id).join(', ')}\n`))
  const results = runMutation(cfg, selected, { cmd: flag('cmd') })
  console.log()
  for (const r of results) {
    const mark = r.passed ? C.g('✓') : C.r('✗')
    console.log(`${mark} ${r.feature.padEnd(16)} ${r.score === null ? C.dim('no mutants') : `${r.score}%`.padStart(6)}  ` +
                `(threshold ${r.threshold}%, ${r.killed} killed, ${r.survived} survived, ${r.no_coverage} uncovered)`)
    for (const m of r.passed ? [] : r.survivors.slice(0, 8)) {
      console.log(C.dim(`    ${m.status.padEnd(10)} ${m.file}:${m.line}  ${m.mutator}${m.replacement ? ` → ${String(m.replacement).slice(0, 50)}` : ''}`))
    }
  }
  console.log(C.dim('\n  summaries written to .cui/mutation/ — commit them with the change'))
  if (results.some((r) => !r.passed)) die('a high-risk feature is below its mutation threshold: add tests that kill the surviving mutants')
}

// ---------------------------------------------------------------- exceptions

function exceptionRows(cfg, within) {
  const today = new Date().toISOString().slice(0, 10)
  return readState(cfg).exceptions.filter((e) => e?.id && e.status !== 'rejected').map((e) => ({
    ...e, days: e.expires ? daysBetween(today, String(e.expires)) : null, in_force: exceptionInForce(e, today),
  })).filter((e) => within === null || e.status !== 'approved' || (e.days !== null && e.days <= within))
}

commands.exceptions = (args) => {
  const { cfg } = context()
  const within = args.flags.expiring ? Number(args.flags.expiring === true ? cfg.exception_warning_days ?? 14 : args.flags.expiring) : null
  const rows = exceptionRows(cfg, within)
  if (!rows.length) return ok(within === null ? 'no exceptions' : `nothing expires within ${within} days`)
  for (const e of rows) {
    const when = e.days === null ? 'no expiry' : e.days < 0 ? C.r(`expired ${-e.days}d ago`) : e.days <= (cfg.exception_warning_days ?? 14) ? C.y(`expires in ${e.days}d`) : `expires in ${e.days}d`
    console.log(`${e.status === 'approved' ? (e.in_force ? C.g('●') : C.r('●')) : C.y('◇')} ${e.id.padEnd(6)} ${String(e.feature).padEnd(16)} ${e.category.padEnd(11)} ${when}  ${C.dim(e.status)}`)
  }
}

// -------------------------------------------------------------------- nightly

// The scheduled CI job: everything that rots slowly. Writes a markdown report; sets
// findings=true in $GITHUB_OUTPUT so the workflow can open or update an issue.
commands.nightly = (args) => {
  const { cfg } = context()
  const days = Number(cfg.exception_warning_days ?? 14)
  const sections = []

  const ex = exceptionRows(cfg, days).filter((e) => e.status === 'approved' || e.status === 'proposed')
  if (ex.length) {
    sections.push(['Exceptions needing attention', ex.map((e) =>
      `- **${e.id}** (${e.feature}, ${e.category}) — ${e.status === 'proposed' ? 'still awaiting approval'
        : e.days < 0 ? `**expired ${-e.days} day(s) ago**` : `expires in ${e.days} day(s) (${e.expires})`}. Owner: ${e.owner ?? '—'}. ${e.reason ?? ''}`)])
  }

  let mutation = []
  if (cfg.mutation_command && args.flags['no-mutation'] !== true) {
    const targets = readState(cfg).features.filter(needsMutation)
    if (targets.length) {
      try { mutation = runMutation(cfg, targets) } catch (err) { sections.push(['Mutation testing failed to run', [`- ${err.message}`]]) }
    }
    const weak = mutation.filter((r) => !r.passed)
    if (weak.length) {
      sections.push(['High-risk features below their mutation threshold', weak.map((r) =>
        `- **${r.feature}** ${r.score ?? 'no mutants'}% (threshold ${r.threshold}%): ${r.survived} survived, ${r.no_coverage} uncovered` +
        r.survivors.slice(0, 5).map((m) => `\n  - \`${m.file}:${m.line}\` ${m.mutator}${m.replacement ? ` → \`${String(m.replacement).slice(0, 40)}\`` : ''}`).join(''))])
    }
  }

  const reg = check(cfg)
  const errs = reg.errors.filter((e) => e.rule !== 'mutation' && e.rule !== 'expired' && e.rule !== 'approval')
  if (errs.length) sections.push(['Registry check errors', errs.map((e) => `- ${e.message}`)])

  const findings = sections.length > 0
  const md = [`# CUI nightly — ${new Date().toISOString().slice(0, 10)}`, '',
    findings ? `${sections.length} area(s) need attention.` : 'Nothing needs attention.', '',
    ...sections.flatMap(([title, lines]) => [`## ${title}`, '', ...lines, '']),
    mutation.length ? `Mutation tested: ${mutation.map((r) => `${r.feature} ${r.score ?? '–'}%`).join(', ')}` : '',
  ].join('\n')

  const out = args.flags.markdown && args.flags.markdown !== true ? args.flags.markdown : null
  if (out) writeFileSync(resolve(cfg.root, out), `${md}\n`)
  else console.log(md)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `findings=${findings}\n`)
  if (args.flags.strict && findings) process.exit(1)
}

commands.help = () => {
  console.log(`
${C.b('cui')} — Central UI for this repository

  ${C.c('cui init')}                      create .cui/, the database and the git hook
  ${C.c('cui serve')} [--dev] [--open]    start the dashboard (default http://localhost:4317)
  ${C.c('cui sync')}                      reload the .cui/*.yaml files into the database
  ${C.c('cui status')} [--brief]          milestone progress and project health
  ${C.c('cui doctor')} [--preflight]      check the project is wired up correctly

  ${C.c('cui ingest')} [--sha X]          record a commit (the git hook does this for you)
  ${C.c('cui backfill')} [--limit N]      record existing history

  ${C.c('cui coverage')} [run|report]     run tests with coverage, report project + diff coverage
  ${C.c('cui demo')} register --dir D     attach a demo directory to a commit
  ${C.c('cui demo')} skip --reason "..."  record why a commit needs no demo
  ${C.c('cui demo')} waive [--note "..."]  record that you chose to ship without one
  ${C.c('cui walkthrough')} generate      generate a walkthrough with Claude Code
  ${C.c('cui install-hooks')}             (re)install the git post-commit hook

  ${C.c('cui test')}                      run test_command (it must write JUnit XML)
  ${C.c('cui registry')} [check|list]     check every active feature has passing tests
                 [--base REF] [--record]  …and nothing was dropped since REF; raise the baseline
  ${C.c('cui ci')} --base REF             everything CI enforces
  ${C.c('cui tdd')} red|green|status FR-X record a red→green cycle for one feature
  ${C.c('cui mutation')} [--feature X|--base REF]  mutation-test risk: high features
  ${C.c('cui exceptions')} [--expiring N] list exceptions, or those expiring within N days
  ${C.c('cui nightly')} [--markdown F]    expiring exceptions, mutation scores, registry — for the nightly job

  ${C.c('cui approvals')}                 what is waiting on a human
  ${C.c('cui approve')} <id> / ${C.c('reject')} <id>  decide a proposal or exception (humans only)
  ${C.c('cui propose')} file|tests ...    write a proposal (blueprint/registry change, test removal)
  ${C.c('cui ratchet')} accept --base REF  approve changes you made to the YAML by hand
`)
}

// ---------------------------------------------------------------------- main

const argv = process.argv.slice(2)
const name = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'help'
const args = parseArgs(argv.slice(name === 'help' && argv[0] !== 'help' ? 0 : 1))
const fn = commands[name] ?? commands.help

try {
  await fn(args)
} catch (err) {
  die(err.message)
}
