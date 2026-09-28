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
test_command: null       # e.g. "npm test"
coverage_command: null   # e.g. "npm test -- --coverage"
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

  if (sub === 'list' || !sub) {
    for (const d of all(db, `select d.*, c.short_sha, c.subject from demos d join commits c on c.sha=d.sha
                             order by c.committed_at desc limit 30`)) {
      const mark = d.status === 'present' ? C.g('●') : d.required ? C.r('○') : C.dim('—')
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
  ${C.c('cui walkthrough')} generate      generate a walkthrough with Claude Code
  ${C.c('cui install-hooks')}             (re)install the git post-commit hook
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
