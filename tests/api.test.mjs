import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadConfig } from '../template/cui/src/server/config.mjs'
import { openDb, run, closeDb } from '../template/cui/src/server/db.mjs'
import { sync } from '../template/cui/src/server/sync.mjs'
import { ingestCommit } from '../template/cui/src/server/ingest.mjs'
import { createApi } from '../template/cui/src/server/api.mjs'

let root, cfg, db, api, sha

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

before(() => {
  root = mkdtempSync(join(tmpdir(), 'cui-api-'))
  mkdirSync(join(root, '.cui'), { recursive: true })
  writeFileSync(join(root, '.cui/config.yaml'), 'enforce: true\n')
  writeFileSync(join(root, '.cui/product-functions.yaml'), `version: 1
product: "Calc"
milestones:
  - key: PF-1
    title: "Arithmetic works"
    demo: "A terminal session"
    status: in_progress
    acceptance:
      - id: PF-1.1
        text: "add is correct"
        status: open
`)

  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  writeFileSync(join(root, 'math.js'), 'export const add = (a, b) => a + b\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'feat(math): add\n\nPF: PF-1 progress\nDemo: skipped - unit tested only')

  cfg = loadConfig(root)
  db = openDb(cfg)
  sync(db, cfg)
  sha = ingestCommit(db, cfg, 'HEAD').sha
  api = createApi(db, cfg)
})

after(() => {
  closeDb()
  rmSync(root, { recursive: true, force: true })
})

describe('GET /commits/:sha', () => {
  test('a ready walkthrough comes back with its markdown', async () => {
    // WalkthroughView renders this row as-is when status is 'ready' and never refetches,
    // so without markdown here the Walkthrough tab shows an empty card after a reload.
    const markdown = '# How add works\n\nIt adds.\n'
    run(db, `insert into walkthroughs(sha, status, markdown, duration_ms, started_at, finished_at)
             values (?, 'ready', ?, 1000, '2026-10-07T00:00:00Z', '2026-10-07T00:00:01Z')`, [sha, markdown])

    const res = await api.request(`/commits/${sha.slice(0, 7)}`)
    assert.equal(res.status, 200)
    const { walkthrough } = await res.json()
    assert.equal(walkthrough.status, 'ready')
    assert.equal(walkthrough.markdown, markdown)
  })
})
