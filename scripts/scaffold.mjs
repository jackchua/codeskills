#!/usr/bin/env node
// Scaffolds the CUI into a project: copies the app, seeds .cui/, installs, builds,
// initialises the database and installs the git hook.

import { execFileSync, execSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'

const HERE = dirname(fileURLToPath(import.meta.url))
const TEMPLATE = resolve(HERE, '../template')

const C = process.stdout.isTTY
  ? { b: (s) => `\x1b[1m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m`,
      g: (s) => `\x1b[32m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`,
      r: (s) => `\x1b[31m${s}\x1b[0m`, c: (s) => `\x1b[36m${s}\x1b[0m` }
  : new Proxy({}, { get: () => (s) => s })

const ok = (m) => console.log(`${C.g('✓')} ${m}`)
const warn = (m) => console.log(`${C.y('!')} ${m}`)
const die = (m) => { console.error(C.r(`scaffold: ${m}`)); process.exit(1) }

const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('--')))
const target = resolve(args.find((a) => !a.startsWith('--')) ?? process.cwd())
const force = flags.has('--force')

async function confirm(question) {
  if (flags.has('--yes')) return true
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase()
  rl.close()
  return answer === 'y' || answer === 'yes'
}

// ---------------------------------------------------------------------------

console.log(`\n${C.b('◈ CUI')} — scaffolding into ${C.c(target)}\n`)

if (!existsSync(TEMPLATE)) die(`template not found at ${TEMPLATE}`)
mkdirSync(target, { recursive: true })

if (existsSync(join(target, 'cui')) && !force) {
  die('a cui/ directory already exists here. Pass --force to overwrite it.')
}

// 1. the app -----------------------------------------------------------------
cpSync(join(TEMPLATE, 'cui'), join(target, 'cui'), {
  recursive: true,
  filter: (src) => !/[/\\](node_modules|dist)([/\\]|$)/.test(src),
})
ok('copied cui/')

// 2. .cui seeds ---------------------------------------------------------------
mkdirSync(join(target, '.cui'), { recursive: true })
cpSync(join(TEMPLATE, '.cui', 'examples'), join(target, '.cui', 'examples'), { recursive: true })
ok('copied .cui/examples/')

// 3. docs ---------------------------------------------------------------------
for (const doc of ['CUI.md']) {
  const from = join(TEMPLATE, doc)
  if (existsSync(from) && (!existsSync(join(target, doc)) || force)) {
    cpSync(from, join(target, doc))
    ok(`wrote ${doc}`)
  }
}

// 4. gitignore ----------------------------------------------------------------
const giPath = join(target, '.gitignore')
const want = ['cui/node_modules/', 'cui/dist/', '.cui/cui.db', '.cui/cui.db-wal', '.cui/cui.db-shm']
const existing = existsSync(giPath) ? readFileSync(giPath, 'utf8') : ''
const missing = want.filter((l) => !existing.split('\n').some((e) => e.trim() === l))
if (missing.length) {
  const prefix = existing ? `${existing.endsWith('\n') ? existing : `${existing}\n`}\n` : ''
  writeFileSync(giPath, `${prefix}# CUI\n${missing.join('\n')}\n`)
  ok(`added ${missing.length} entries to .gitignore`)
}

// 5. root package.json scripts -------------------------------------------------
const pkgPath = join(target, 'package.json')
if (existsSync(pkgPath)) {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  pkg.scripts ??= {}
  let added = 0
  for (const [k, v] of Object.entries({
    cui: 'node cui/bin/cui.mjs serve',
    'cui:status': 'node cui/bin/cui.mjs status',
    'cui:doctor': 'node cui/bin/cui.mjs doctor',
  })) {
    if (!pkg.scripts[k]) { pkg.scripts[k] = v; added++ }
  }
  if (added) {
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
    ok(`added ${added} npm script(s) to package.json`)
  }
} else {
  warn('no package.json here — run the CUI with `node cui/bin/cui.mjs serve`')
}

// 6. install + build -----------------------------------------------------------
if (!flags.has('--no-install')) {
  console.log(C.dim('\n  npm install (cui/) …'))
  try {
    execSync('npm install --no-audit --no-fund --loglevel=error', {
      cwd: join(target, 'cui'), stdio: 'inherit',
    })
    ok('installed dependencies')
    execSync('npm run build --silent', { cwd: join(target, 'cui'), stdio: 'inherit' })
    ok('built the dashboard')
  } catch {
    warn('install or build failed — run it yourself: npm --prefix cui install && npm --prefix cui run build')
  }
}

// 7. git + init -----------------------------------------------------------------
let isRepo = false
try {
  execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: target, stdio: 'ignore' })
  isRepo = true
} catch { /* not a repo */ }

if (!isRepo) {
  if (await confirm('This is not a git repository. Run `git init`?')) {
    execFileSync('git', ['init', '-q'], { cwd: target })
    ok('git init')
    isRepo = true
  } else {
    warn('without git there is no commit tracking — the CUI will only show milestones and structure')
  }
}

// `cui init` needs the app's dependencies, so it cannot run before an install.
if (flags.has('--no-install')) {
  warn('skipped `cui init` (--no-install). Once you have installed, run:')
  console.log(C.dim('    npm --prefix cui install && npm --prefix cui run build'))
  console.log(C.dim('    node cui/bin/cui.mjs init'))
} else {
  try {
    execFileSync('node', ['cui/bin/cui.mjs', 'init'], { cwd: target, stdio: 'inherit' })
  } catch {
    warn('`cui init` failed — run it yourself: node cui/bin/cui.mjs init')
  }
}

// ---------------------------------------------------------------------------

console.log(`
${C.b('Done.')} What happens next, in order:

  ${C.c('1.')} In Claude Code, run ${C.c('/pf')}
     Defines the Product Function milestones. It interviews you first and will not
     write code until you approve the list.

  ${C.c('2.')} Run ${C.c('/blueprint')}
     Locks the directory layout, boundary rules, entry points and command catalogue.

     ${C.dim('Until both are done, a PreToolUse hook blocks implementation writes.')}
     ${C.dim('That is the point — it is what stops the codebase getting away from you.')}

  ${C.c('3.')} Build, and commit with ${C.c('/ship')}
     Tests, coverage, a demo decision and milestone scoring happen as part of committing.

  ${C.c('4.')} Open the dashboard
     ${C.dim(existsSync(pkgPath) ? 'npm run cui' : 'node cui/bin/cui.mjs serve')}   →  http://localhost:4317

${C.dim('Shape references for the .cui/*.yaml files are in .cui/examples/.')}
`)
