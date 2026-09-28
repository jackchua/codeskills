import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseTrailers } from '../template/cui/src/server/ingest.mjs'
import {
  parseLcov, parseCobertura, parseIstanbulJson, parseCoveragePyJson, parseGoCover,
  projectTotals, diffTotals, matchesAny, pct,
} from '../template/cui/src/server/coverage.mjs'

const ROOT = mkdtempSync(join(tmpdir(), 'cui-test-'))

describe('commit trailers', () => {
  test('parses a full ship-commit message', () => {
    const t = parseTrailers(`feat(seed): generate orders

Some body text explaining why.

PF: PF-2 progress (PF-2.1, PF-2.3 met)
PF: PF-4 groundwork
Coverage: project 78.4% (+1.2), diff 91.3%
Demo: demos/004-orders - 500 rows, realism checks pass
Blueprint: unchanged`)

    assert.equal(t.found, true)
    assert.equal(t.milestones.length, 2)
    assert.deepEqual(t.milestones[0], {
      key: 'PF-2', impact: 'progress', criteria_met: ['PF-2.1', 'PF-2.3'], note: null,
    })
    assert.equal(t.milestones[1].impact, 'groundwork')
    assert.deepEqual(t.milestones[1].criteria_met, [])
    assert.equal(t.coverage.project_pct, 78.4)
    assert.equal(t.coverage.diff_pct, 91.3)
    assert.equal(t.demo.status, 'present')
    assert.equal(t.demo.dir, 'demos/004-orders')
    assert.equal(t.demo.claim, '500 rows, realism checks pass')
    assert.equal(t.blueprint, 'unchanged')
  })

  test('parses a skipped demo with its reason', () => {
    const t = parseTrailers('x\n\nDemo: skipped - pure refactor, output byte-identical')
    assert.equal(t.demo.status, 'skipped')
    assert.equal(t.demo.required, false)
    assert.equal(t.demo.reason, 'pure refactor, output byte-identical')
  })

  test('accepts an em-dash separator', () => {
    const t = parseTrailers('x\n\nDemo: skipped — nothing observable changed')
    assert.equal(t.demo.status, 'skipped')
    assert.equal(t.demo.reason, 'nothing observable changed')
  })

  test('PF: none records an explicit no-milestone decision', () => {
    const t = parseTrailers('chore: bump deps\n\nPF: none')
    assert.equal(t.milestones.length, 1)
    assert.equal(t.milestones[0].key, null)
    assert.equal(t.milestones[0].impact, 'none')
  })

  test('a message with no trailers is flagged, not guessed at', () => {
    const t = parseTrailers('fix: typo\n\nJust a typo.')
    assert.equal(t.found, false)
    assert.deepEqual(t.milestones, [])
    assert.equal(t.coverage, null)
    assert.equal(t.demo, null)
  })

  test('an unrecognised impact word degrades to progress rather than being dropped', () => {
    const t = parseTrailers('x\n\nPF: PF-9 wibble')
    assert.equal(t.milestones[0].key, 'PF-9')
    assert.equal(t.milestones[0].impact, 'progress')
    assert.equal(t.milestones[0].unparsed, true)
  })

  test('tests: failing is recorded', () => {
    assert.equal(parseTrailers('x\n\nTests: failing').tests, 'failing')
  })
})

describe('coverage parsers', () => {
  const cfg = { root: ROOT, ignore_paths: [] }

  test('lcov', () => {
    const files = parseLcov(
      'TN:\nSF:src/a.js\nDA:1,3\nDA:2,0\nDA:5,1\nLF:3\nLH:2\nend_of_record\n', ROOT)
    assert.deepEqual([...files.keys()], ['src/a.js'])
    assert.equal(files.get('src/a.js').get(1), 3)
    assert.equal(files.get('src/a.js').get(2), 0)
    assert.equal(files.get('src/a.js').size, 3)
  })

  test('lcov with absolute SF paths normalises to repo-relative', () => {
    const files = parseLcov(`TN:\nSF:${ROOT}/src/b.js\nDA:1,1\nend_of_record\n`, ROOT)
    assert.deepEqual([...files.keys()], ['src/b.js'])
  })

  test('cobertura', () => {
    const files = parseCobertura(`<?xml version="1.0"?>
      <coverage><packages><package><classes>
        <class filename="app/x.py"><lines>
          <line number="1" hits="2"/><line number="4" hits="0"/>
        </lines></class>
      </classes></package></packages></coverage>`, ROOT)
    assert.equal(files.get('app/x.py').get(1), 2)
    assert.equal(files.get('app/x.py').get(4), 0)
  })

  test('istanbul coverage-final.json maps statements to lines', () => {
    const files = parseIstanbulJson(JSON.stringify({
      'src/c.ts': {
        path: 'src/c.ts',
        statementMap: { 0: { start: { line: 3 }, end: { line: 3 } }, 1: { start: { line: 7 }, end: { line: 8 } } },
        s: { 0: 5, 1: 0 },
      },
    }), ROOT)
    assert.equal(files.get('src/c.ts').get(3), 5)
    assert.equal(files.get('src/c.ts').get(7), 0)
    assert.equal(files.get('src/c.ts').get(8), 0)
  })

  test('coverage.py json', () => {
    const files = parseCoveragePyJson(JSON.stringify({
      files: { 'pkg/m.py': { executed_lines: [1, 2], missing_lines: [9] } },
    }), ROOT)
    assert.equal(files.get('pkg/m.py').get(1), 1)
    assert.equal(files.get('pkg/m.py').get(9), 0)
  })

  test('go cover expands statement ranges', () => {
    const files = parseGoCover('mode: set\nexample.com/m/pkg/a.go:10.20,13.2 2 1\n', ROOT)
    const m = [...files.values()][0]
    assert.deepEqual([...m.keys()], [10, 11, 12, 13])
    assert.equal(m.get(12), 1)
  })
})

describe('totals', () => {
  const coverage = {
    tool: 'lcov',
    files: new Map([
      ['src/a.js', new Map([[1, 1], [2, 0], [3, 4]])],
      ['src/b.js', new Map([[1, 1], [2, 1]])],
    ]),
  }

  test('project totals count executed lines across files', () => {
    const p = projectTotals(coverage)
    assert.equal(p.total, 5)
    assert.equal(p.covered, 4)
    assert.equal(p.pct, 80)
  })

  test('diff coverage counts only the lines the commit added', () => {
    const added = new Map([['src/a.js', new Set([2, 3])]])
    const d = diffTotals(coverage, added)
    assert.equal(d.total, 2)      // lines 2 and 3 are both executable
    assert.equal(d.covered, 1)    // only line 3 is executed
    assert.equal(d.pct, 50)
  })

  test('non-executable added lines (blanks, comments, braces) are excluded', () => {
    // Line 99 has no DA record, so it is not executable and must not drag the ratio down.
    const d = diffTotals(coverage, new Map([['src/a.js', new Set([3, 99])]]))
    assert.equal(d.total, 1)
    assert.equal(d.covered, 1)
    assert.equal(d.pct, 100)
  })

  test('added lines in files the coverage tool never saw are ignored', () => {
    const d = diffTotals(coverage, new Map([['README.md', new Set([1, 2, 3])]]))
    assert.equal(d.total, 0)
    assert.equal(d.pct, null)
  })

  test('a commit that adds no executable lines reports null, not 0%', () => {
    assert.equal(pct(0, 0), null)
    assert.equal(pct(0, 4), 0)
  })
})

describe('ignore globs', () => {
  test('** matches across directory boundaries', () => {
    assert.equal(matchesAny('node_modules/x/y.js', ['node_modules/**']), true)
    assert.equal(matchesAny('cui/src/server/db.mjs', ['cui/**']), true)
    assert.equal(matchesAny('src/cui.ts', ['cui/**']), false)
  })

  test('* does not cross a slash', () => {
    assert.equal(matchesAny('src/a.js', ['src/*']), true)
    assert.equal(matchesAny('src/deep/a.js', ['src/*']), false)
    assert.equal(matchesAny('src/deep/a.js', ['src/**']), true)
  })

  test('dots are literal, not wildcards', () => {
    assert.equal(matchesAny('axbxc', ['a.b.c']), false)
    assert.equal(matchesAny('a.b.c', ['a.b.c']), true)
  })
})
