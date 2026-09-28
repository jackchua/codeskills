import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

const toPosix = (p) => p.split(sep).join('/')

const normalise = (root, p) => {
  if (!p) return null
  const abs = isAbsolute(p) ? p : resolve(root, p)
  const rel = relative(root, abs)
  return rel.startsWith('..') ? toPosix(p) : toPosix(rel)
}

const globToRe = (glob) =>
  new RegExp(
    '^' +
      glob
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\//g, '\u0000')
        .replace(/\*\*/g, '\u0001')
        .replace(/\*/g, '[^/]*')
        .replace(/\u0000/g, '(?:.*/)?')
        .replace(/\u0001/g, '.*')
        .replace(/\?/g, '[^/]') +
      '$',
  )

export const matchesAny = (path, globs) => globs.some((g) => globToRe(g).test(path))

// ---------------------------------------------------------------- parsers
// Every parser returns Map<relPath, Map<lineNumber, hitCount>>.

export function parseLcov(text, root) {
  const files = new Map()
  let path = null
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('SF:')) {
      path = normalise(root, line.slice(3))
      if (!files.has(path)) files.set(path, new Map())
    } else if (line.startsWith('DA:') && path) {
      const [n, hits] = line.slice(3).split(',')
      const lineNo = Number(n)
      const count = Number(hits)
      const m = files.get(path)
      m.set(lineNo, (m.get(lineNo) ?? 0) + (Number.isFinite(count) ? count : 0))
    } else if (line === 'end_of_record') {
      path = null
    }
  }
  return files
}

export function parseCobertura(xml, root) {
  const files = new Map()
  // <class ... filename="x"> ... <line number="1" hits="3"/> ... </class>
  const classRe = /<class\b[^>]*\bfilename="([^"]+)"[^>]*>([\s\S]*?)<\/class>/g
  const lineRe = /<line\b[^>]*\bnumber="(\d+)"[^>]*\bhits="(\d+)"/g
  const sourceRe = /<source>([^<]*)<\/source>/g

  const sources = []
  let s
  while ((s = sourceRe.exec(xml))) sources.push(s[1].trim())

  let c
  while ((c = classRe.exec(xml))) {
    const raw = c[1]
    // Cobertura filenames are relative to <source>; try each until one exists.
    let resolved = raw
    if (!existsSync(resolve(root, raw))) {
      for (const src of sources) {
        const candidate = isAbsolute(src) ? join(src, raw) : join(root, src, raw)
        if (existsSync(candidate)) { resolved = candidate; break }
      }
    }
    const path = normalise(root, resolved)
    if (!files.has(path)) files.set(path, new Map())
    const m = files.get(path)
    let l
    lineRe.lastIndex = 0
    while ((l = lineRe.exec(c[2]))) {
      const n = Number(l[1])
      m.set(n, (m.get(n) ?? 0) + Number(l[2]))
    }
  }
  return files
}

/** Istanbul coverage-final.json */
export function parseIstanbulJson(text, root) {
  const files = new Map()
  const data = JSON.parse(text)
  for (const [file, entry] of Object.entries(data)) {
    const path = normalise(root, entry.path ?? file)
    const m = new Map()
    const bump = (loc, hits) => {
      const start = loc?.start?.line
      const end = loc?.end?.line ?? start
      if (!start) return
      for (let n = start; n <= end; n++) m.set(n, Math.max(m.get(n) ?? 0, hits))
    }
    for (const [id, loc] of Object.entries(entry.statementMap ?? {})) bump(loc, entry.s?.[id] ?? 0)
    for (const [id, fn] of Object.entries(entry.fnMap ?? {})) bump(fn.loc ?? fn.decl, entry.f?.[id] ?? 0)
    files.set(path, m)
  }
  return files
}

/** coverage.py `coverage json` output */
export function parseCoveragePyJson(text, root) {
  const files = new Map()
  const data = JSON.parse(text)
  for (const [file, entry] of Object.entries(data.files ?? {})) {
    const path = normalise(root, file)
    const m = new Map()
    for (const n of entry.executed_lines ?? []) m.set(Number(n), 1)
    for (const n of entry.missing_lines ?? []) m.set(Number(n), 0)
    files.set(path, m)
  }
  return files
}

/** Go `go test -coverprofile` */
export function parseGoCover(text, root) {
  const files = new Map()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('mode:')) continue
    const m = line.match(/^(.+):(\d+)\.\d+,(\d+)\.\d+\s+\d+\s+(\d+)$/)
    if (!m) continue
    // Go writes import paths; keep only the part that exists under root.
    let file = m[1]
    if (!existsSync(resolve(root, file))) {
      const parts = file.split('/')
      for (let i = 1; i < parts.length; i++) {
        const candidate = parts.slice(i).join('/')
        if (existsSync(resolve(root, candidate))) { file = candidate; break }
      }
    }
    const path = normalise(root, file)
    if (!files.has(path)) files.set(path, new Map())
    const map = files.get(path)
    const count = Number(m[4])
    for (let n = Number(m[2]); n <= Number(m[3]); n++) {
      map.set(n, Math.max(map.get(n) ?? 0, count))
    }
  }
  return files
}

// ---------------------------------------------------------------- detection

const DETECTORS = [
  { test: (p) => /lcov.*\.info$/.test(p), tool: 'lcov', parse: parseLcov },
  { test: (p) => /coverage-final\.json$/.test(p), tool: 'istanbul', parse: parseIstanbulJson },
  { test: (p) => /\.xml$/.test(p), tool: 'cobertura', parse: parseCobertura },
  { test: (p) => /coverage\.out$/.test(p), tool: 'go', parse: parseGoCover },
  {
    test: (p) => /\.json$/.test(p),
    tool: 'coverage.py',
    parse: (t, r) => (JSON.parse(t).files ? parseCoveragePyJson(t, r) : parseIstanbulJson(t, r)),
  },
]

export function findCoverageFile(cfg) {
  for (const candidate of cfg.coverage_files) {
    const abs = resolve(cfg.root, candidate)
    if (existsSync(abs)) return abs
  }
  return null
}

export function loadCoverage(cfg, file) {
  // Note: `?? findCoverageFile` rather than a default parameter — callers pass an
  // explicit null to mean "find it for me", and defaults only fire on undefined.
  file = file ?? findCoverageFile(cfg)
  if (!file) return null
  const rel = toPosix(relative(cfg.root, file))
  const detector = DETECTORS.find((d) => d.test(rel))
  if (!detector) return null
  let files
  try {
    files = detector.parse(readFileSync(file, 'utf8'), cfg.root)
  } catch (err) {
    throw new Error(`failed to parse ${rel} as ${detector.tool}: ${err.message}`)
  }
  // Drop anything the project told us not to count.
  for (const path of [...files.keys()]) {
    if (matchesAny(path, cfg.ignore_paths)) files.delete(path)
  }
  return { tool: detector.tool, file: rel, files }
}

// ---------------------------------------------------------------- totals

export function projectTotals(coverage) {
  let covered = 0
  let total = 0
  const perFile = []
  for (const [path, lines] of coverage.files) {
    let c = 0
    for (const hits of lines.values()) if (hits > 0) c++
    covered += c
    total += lines.size
    perFile.push({ path, covered: c, total: lines.size, pct: pct(c, lines.size) })
  }
  return { covered, total, pct: pct(covered, total), perFile }
}

/**
 * Diff coverage: restrict to the lines this commit added. This is the number that
 * actually says whether the new work is tested — project coverage can rise while a
 * commit adds nothing but untested code.
 */
export function diffTotals(coverage, added) {
  let covered = 0
  let total = 0
  const perFile = new Map()
  for (const [path, lineNumbers] of added) {
    const lines = coverage.files.get(path)
    if (!lines) continue // not an instrumented source file (config, markdown, fixtures)
    let c = 0
    let t = 0
    for (const n of lineNumbers) {
      if (!lines.has(n)) continue // blank line, comment, brace — not executable
      t++
      if (lines.get(n) > 0) c++
    }
    if (t === 0) continue
    covered += c
    total += t
    perFile.set(path, { covered: c, total: t, pct: pct(c, t) })
  }
  return { covered, total, pct: pct(covered, total), perFile }
}

export function pct(covered, total) {
  if (!total) return null
  return Math.round((covered / total) * 1000) / 10
}
