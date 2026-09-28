import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadConfig } from '../template/cui/src/server/config.mjs'
import { openDb, get, all, closeDb } from '../template/cui/src/server/db.mjs'
import { sync } from '../template/cui/src/server/sync.mjs'
import { ingestCommit } from '../template/cui/src/server/ingest.mjs'
import { addedLines } from '../template/cui/src/server/git.mjs'

let root, cfg, db

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

// A source file whose executable lines we control exactly, so diff coverage is checkable.
const SRC_V1 = `export function add(a, b) {
  return a + b
}

export function sub(a, b) {
  return a - b
}
`
// Appends a third function; only the first of its two executable lines is covered.
const SRC_V2 = `${SRC_V1}
export function mul(a, b) {
  if (a === 0) return 0
  return a * b
}
`

const lcov = (entries) =>
  `TN:\nSF:src/math.js\n${entries.map(([n, h]) => `DA:${n},${h}`).join('\n')}\nend_of_record\n`

before(() => {
  root = mkdtempSync(join(tmpdir(), 'cui-ingest-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, '.cui'), { recursive: true })
  mkdirSync(join(root, 'coverage'), { recursive: true })

  writeFileSync(join(root, '.cui/config.yaml'), 'enforce: true\n')
  writeFileSync(join(root, '.cui/product-functions.yaml'), `version: 1
product: "Calc"
milestones:
  - key: PF-1
    title: "Arithmetic works"
    demo: "A terminal session showing each operation"
    status: in_progress
    acceptance:
      - id: PF-1.1
        text: "add and sub are correct"
        status: open
      - id: PF-1.2
        text: "mul is correct"
        status: open
`)
  writeFileSync(join(root, '.cui/blueprint.yaml'), `version: 1
locked: true
layout:
  - path: src
    purpose: "math"
    forbidden: ["io"]
entrypoints:
  - id: cli
    kind: cli
    command: "node src/cli.js"
    path: src/cli.js
`)

  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')

  writeFileSync(join(root, 'src/math.js'), SRC_V1)
  git('add', '-A')
  git('commit', '-q', '-m', 'feat(math): add and sub\n\nPF: PF-1 progress (PF-1.1 met)\nDemo: skipped - covered by unit tests, no observable surface yet')

  writeFileSync(join(root, 'src/math.js'), SRC_V2)
  // Lines 9-12 are the new function; 10 and 11 are executable, only 10 is covered.
  writeFileSync(join(root, 'coverage/lcov.info'), lcov([
    [1, 3], [2, 3], [5, 1], [6, 1], [9, 1], [10, 2], [11, 0],
  ]))
  mkdirSync(join(root, 'demos/002-mul'), { recursive: true })
  writeFileSync(join(root, 'demos/002-mul/demo.md'), '# mul works\n\n## Claim\n\n3 * 4 = 12\n')
  writeFileSync(join(root, 'demos/002-mul/run.sh'), '#!/bin/sh\nnode -e "console.log(3*4)"\n')
  writeFileSync(join(root, 'demos/002-mul/01-output.txt'), '12\n')
  git('add', '-A')
  git('commit', '-q', '-m', `feat(math): multiplication

Zero short-circuits before the multiply so callers can pass sentinel zeros.

PF: PF-1 progress (PF-1.2 met)
Coverage: project 85.7%, diff 50.0%
Demo: demos/002-mul - 3 * 4 = 12
Blueprint: unchanged`)

  cfg = loadConfig(root)
  db = openDb(cfg)
  sync(db, cfg)
})

after(() => {
  closeDb()
  rmSync(root, { recursive: true, force: true })
})

describe('ingesting a commit', () => {
  test('addedLines reports post-commit line numbers of added lines only', () => {
    const added = addedLines(root, 'HEAD')
    assert.deepEqual([...added.get('src/math.js')].sort((a, b) => a - b), [8, 9, 10, 11, 12])
  })

  test('records the commit with its stats and trailers', () => {
    const r = ingestCommit(db, cfg, 'HEAD')
    assert.equal(r.unparsed, false)

    const c = get(db, 'select * from commits where sha = ?', [r.sha])
    assert.equal(c.subject, 'feat(math): multiplication')
    assert.match(c.body, /sentinel zeros/)
    assert.equal(c.blueprint_note, 'unchanged')
    assert.ok(c.files_changed >= 4)
  })

  test('computes diff coverage from the added lines, not from the trailer', () => {
    ingestCommit(db, cfg, 'HEAD')
    const cov = get(db, 'select * from coverage where sha = ?',
      [execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()])

    assert.equal(cov.tool, 'lcov', 'should parse the lcov artifact, not fall back to the trailer')
    // Of the added lines 8-12, only 9, 10 and 11 have DA records. 9 and 10 are hit.
    assert.equal(cov.diff_total, 3)
    assert.equal(cov.diff_covered, 2)
    assert.equal(cov.diff_pct, 66.7)
    // Project: 7 DA records, 6 with a non-zero hit count.
    assert.equal(cov.project_total, 7)
    assert.equal(cov.project_covered, 6)
    assert.equal(cov.project_pct, 85.7)
  })

  test('scores the commit against the milestone and marks the criterion met', () => {
    ingestCommit(db, cfg, 'HEAD')
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    const m = get(db, 'select * from commit_milestones where sha = ?', [sha])
    assert.equal(m.milestone_key, 'PF-1')
    assert.equal(m.impact, 'progress')
    assert.deepEqual(JSON.parse(m.criteria_met), ['PF-1.2'])
    assert.equal(get(db, "select status from criteria where id = 'PF-1.2'").status, 'met')
  })

  test('finds and indexes the demo directory named in the trailer', () => {
    const r = ingestCommit(db, cfg, 'HEAD')
    const d = get(db, 'select * from demos where sha = ?', [r.sha])
    assert.equal(d.status, 'present')
    assert.equal(d.dir, 'demos/002-mul')
    assert.equal(d.title, 'mul works')
    assert.equal(d.claim, '3 * 4 = 12')
    const artifacts = JSON.parse(d.artifacts)
    assert.equal(artifacts.length, 3)
    assert.ok(artifacts.some((a) => a.name === 'run.sh' && a.kind === 'script'))
    assert.ok(artifacts.some((a) => a.name === 'demo.md' && a.kind === 'markdown'))
  })

  test('records a deliberate demo skip with its reason', () => {
    const r = ingestCommit(db, cfg, 'HEAD~1')
    const d = get(db, 'select * from demos where sha = ?', [r.sha])
    assert.equal(d.status, 'skipped')
    assert.equal(d.required, 0)
    assert.match(d.reason, /no observable surface yet/)
  })

  test('re-ingesting the same commit is idempotent', () => {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    ingestCommit(db, cfg, 'HEAD')
    ingestCommit(db, cfg, 'HEAD')
    assert.equal(get(db, 'select count(*) n from commits where sha = ?', [sha]).n, 1)
    assert.equal(get(db, 'select count(*) n from commit_milestones where sha = ?', [sha]).n, 1)
    assert.equal(all(db, 'select * from commit_files where sha = ?', [sha]).length,
                 get(db, 'select files_changed f from commits where sha = ?', [sha]).f)
  })
})

describe('syncing the YAML', () => {
  test('loads milestones, criteria, layout, entrypoints', () => {
    const r = sync(db, cfg)
    assert.equal(r.milestones, 1)
    assert.equal(r.criteria, 2)
    assert.equal(r.layout, 1)
    assert.equal(r.entrypoints, 1)
  })

  test('warns about a milestone with no demo line', () => {
    writeFileSync(join(root, '.cui/product-functions.yaml'), `version: 1
milestones:
  - key: PF-9
    title: "No proof described"
    status: not_started
`)
    const r = sync(db, cfg)
    assert.ok(r.warnings.some((w) => /PF-9 has no demo/.test(w)))
    assert.ok(r.warnings.some((w) => /PF-9 has no acceptance criteria/.test(w)))
  })

  test('a milestone removed from the YAML is marked dropped, not deleted', () => {
    // PF-1 is gone from the file above, but commits still reference it.
    const m = get(db, "select * from milestones where key = 'PF-1'")
    assert.equal(m.status, 'dropped')
    assert.match(m.dropped_reason, /removed from product-functions.yaml/)
  })
})
