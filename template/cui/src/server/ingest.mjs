import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import * as G from './git.mjs'
import { loadCoverage, projectTotals, diffTotals, pct } from './coverage.mjs'
import { run, get, all } from './db.mjs'

const IMPACTS = new Set(['enabled', 'progress', 'groundwork', 'none'])

/**
 * Parses the trailers ship-commit writes:
 *   PF: PF-2 progress (PF-2.1, PF-2.3 met)
 *   Coverage: project 78.4% (+1.2), diff 91.3%
 *   Demo: demos/a1b2c3d/ - 500 synthetic orders, realism checks pass
 *   Blueprint: added src/workers (PF-4 needs a queue consumer)
 */
export function parseTrailers(message) {
  const out = { milestones: [], coverage: null, demo: null, blueprint: null, tests: null, found: false }

  for (const raw of (message ?? '').split('\n')) {
    const line = raw.trim()

    let m = line.match(/^PF:\s*(.+)$/i)
    if (m) {
      out.found = true
      const value = m[1].trim()
      if (/^none\b/i.test(value)) { out.milestones.push({ key: null, impact: 'none', note: value }); continue }
      const parsed = value.match(/^([\w.-]+)\s+(\w+)\s*(?:\(([^)]*)\))?\s*(?:[-–—]\s*(.*))?$/)
      if (parsed && IMPACTS.has(parsed[2].toLowerCase())) {
        const met = (parsed[3] ?? '')
          .split(',').map((s) => s.trim().replace(/\s+met$/i, '')).filter(Boolean)
        out.milestones.push({
          key: parsed[1], impact: parsed[2].toLowerCase(), criteria_met: met, note: parsed[4] ?? null,
        })
      } else {
        out.milestones.push({ key: value.split(/\s+/)[0], impact: 'progress', note: value, unparsed: true })
      }
      continue
    }

    m = line.match(/^Coverage:\s*(.+)$/i)
    if (m) {
      out.found = true
      const p = m[1].match(/project\s+([\d.]+)%/i)
      const d = m[1].match(/diff\s+([\d.]+)%/i)
      out.coverage = { project_pct: p ? Number(p[1]) : null, diff_pct: d ? Number(d[1]) : null }
      continue
    }

    m = line.match(/^Demo:\s*(.+)$/i)
    if (m) {
      out.found = true
      const value = m[1].trim()
      const skipped = value.match(/^skipp?ed\s*[-–—:]\s*(.+)$/i)
      if (skipped) out.demo = { status: 'skipped', required: false, reason: skipped[1].trim() }
      else {
        const parts = value.split(/\s+[-–—]\s+/)
        out.demo = { status: 'present', required: true, dir: parts[0].replace(/\/$/, ''), claim: parts[1] ?? null }
      }
      continue
    }

    m = line.match(/^Blueprint:\s*(.+)$/i)
    if (m) { out.found = true; out.blueprint = m[1].trim(); continue }

    m = line.match(/^Tests:\s*(\w+)/i)
    if (m) { out.found = true; out.tests = m[1].toLowerCase(); continue }
  }

  return out
}

const ARTIFACT_KIND = {
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.webp': 'image', '.svg': 'image',
  '.md': 'markdown', '.markdown': 'markdown',
  '.txt': 'text', '.log': 'text', '.out': 'text', '.diff': 'text', '.patch': 'text',
  '.json': 'json', '.csv': 'table',
  '.cast': 'asciicast',
  '.mp4': 'video', '.webm': 'video', '.mov': 'video',
  '.sh': 'script', '.bash': 'script', '.mjs': 'script', '.py': 'script',
}

export function scanDemoDir(root, dir) {
  const abs = join(root, dir)
  if (!existsSync(abs) || !statSync(abs).isDirectory()) return null
  const artifacts = []
  for (const name of readdirSync(abs).sort()) {
    const full = join(abs, name)
    const st = statSync(full)
    if (st.isDirectory()) continue
    artifacts.push({
      name,
      path: `${dir}/${name}`,
      kind: ARTIFACT_KIND[extname(name).toLowerCase()] ?? 'file',
      bytes: st.size,
    })
  }
  let title = null
  let claim = null
  const readme = join(abs, 'demo.md')
  if (existsSync(readme)) {
    const text = readFileSync(readme, 'utf8')
    title = text.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? null
    claim = text.match(/^##\s+Claim\s*\n+([\s\S]*?)(?=\n##\s|\n*$)/mi)?.[1]?.trim() ?? null
  }
  return { artifacts, title, claim, hasRunScript: artifacts.some((a) => /^run\.(sh|mjs|py)$/.test(a.name)) }
}

/** Records one commit — stats, coverage, demo and milestone scoring — into the CUI. */
export function ingestCommit(db, cfg, ref = 'HEAD', { coverageFile = null } = {}) {
  const root = cfg.root
  const sha = G.resolveSha(root, ref)
  const meta = G.commitMeta(root, sha)
  const files = G.commitFiles(root, sha)
  const trailers = parseTrailers(`${meta.subject}\n${meta.body}`)

  const insertions = files.reduce((a, f) => a + f.insertions, 0)
  const deletions = files.reduce((a, f) => a + f.deletions, 0)

  run(db, `insert into commits(sha, short_sha, subject, body, author_name, author_email,
             committed_at, branch, parent_sha, files_changed, insertions, deletions,
             tests_status, blueprint_note, unparsed, ingested_at)
           values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           on conflict(sha) do update set
             subject=excluded.subject, body=excluded.body, branch=excluded.branch,
             files_changed=excluded.files_changed, insertions=excluded.insertions,
             deletions=excluded.deletions, tests_status=excluded.tests_status,
             blueprint_note=excluded.blueprint_note, unparsed=excluded.unparsed,
             ingested_at=excluded.ingested_at`,
    [sha, meta.short_sha, meta.subject, meta.body, meta.author_name, meta.author_email,
     meta.committed_at, G.currentBranch(root), meta.parent_sha, files.length, insertions, deletions,
     trailers.tests ?? 'unknown', trailers.blueprint, trailers.found ? 0 : 1, new Date().toISOString()])

  run(db, `delete from commit_files where sha = ?`, [sha])
  for (const f of files) {
    run(db, `insert into commit_files(sha, path, change, insertions, deletions) values(?,?,?,?,?)`,
      [sha, f.path, f.change, f.insertions, f.deletions])
  }

  // ---- milestone scoring
  run(db, `delete from commit_milestones where sha = ?`, [sha])
  const known = new Set(all(db, `select key from milestones`).map((r) => r.key))
  const unknownKeys = []
  for (const ms of trailers.milestones) {
    if (!ms.key) {
      run(db, `insert into commit_milestones(sha, milestone_key, impact, note, criteria_met)
               values(?,?,?,?,?)`, [sha, '(none)', 'none', ms.note, []])
      continue
    }
    if (!known.has(ms.key)) unknownKeys.push(ms.key)
    run(db, `insert into commit_milestones(sha, milestone_key, impact, note, criteria_met)
             values(?,?,?,?,?)
             on conflict(sha, milestone_key) do update set impact=excluded.impact,
               note=excluded.note, criteria_met=excluded.criteria_met`,
      [sha, ms.key, ms.impact, ms.note, ms.criteria_met ?? []])

    // A commit that reports criteria met updates the criteria table, so the
    // milestone page reflects reality without a manual YAML edit.
    for (const id of ms.criteria_met ?? []) {
      run(db, `update criteria set status='met' where id = ?`, [id])
    }
  }

  // ---- coverage
  let coverageResult = null
  try {
    const cov = loadCoverage(cfg, coverageFile)
    if (cov) {
      const project = projectTotals(cov)
      const added = G.addedLines(root, sha)
      const diff = diffTotals(cov, added)
      run(db, `insert into coverage(sha, project_pct, project_covered, project_total,
                 diff_pct, diff_covered, diff_total, tool, measured_at)
               values(?,?,?,?,?,?,?,?,?)
               on conflict(sha) do update set project_pct=excluded.project_pct,
                 project_covered=excluded.project_covered, project_total=excluded.project_total,
                 diff_pct=excluded.diff_pct, diff_covered=excluded.diff_covered,
                 diff_total=excluded.diff_total, tool=excluded.tool, measured_at=excluded.measured_at`,
        [sha, project.pct, project.covered, project.total,
         diff.pct, diff.covered, diff.total, cov.tool, new Date().toISOString()])

      run(db, `delete from file_coverage where sha = ?`, [sha])
      for (const f of project.perFile) {
        const d = diff.perFile.get(f.path)
        if (!d && !files.some((cf) => cf.path === f.path)) continue // only store touched files
        run(db, `insert into file_coverage(sha, path, covered, total, pct, diff_covered, diff_total)
                 values(?,?,?,?,?,?,?)`,
          [sha, f.path, f.covered, f.total, f.pct, d?.covered ?? 0, d?.total ?? 0])
      }
      coverageResult = { project, diff, tool: cov.tool }
    } else if (trailers.coverage) {
      // No artifact on disk (e.g. backfilling old commits) — trust the trailer.
      run(db, `insert into coverage(sha, project_pct, diff_pct, tool, measured_at)
               values(?,?,?,?,?)
               on conflict(sha) do update set project_pct=excluded.project_pct,
                 diff_pct=excluded.diff_pct, tool=excluded.tool`,
        [sha, trailers.coverage.project_pct, trailers.coverage.diff_pct, 'trailer', new Date().toISOString()])
    }
  } catch (err) {
    coverageResult = { error: err.message }
  }

  // ---- demo
  const declaredDir = trailers.demo?.dir
  const conventionalDir = `demos/${meta.short_sha}`
  const dir = declaredDir && existsSync(join(root, declaredDir)) ? declaredDir
    : existsSync(join(root, conventionalDir)) ? conventionalDir : null
  const scan = dir ? scanDemoDir(root, dir) : null

  if (scan) {
    run(db, `insert into demos(sha, required, status, reason, dir, title, claim, artifacts, registered_at)
             values(?,?,?,?,?,?,?,?,?)
             on conflict(sha) do update set required=excluded.required, status=excluded.status,
               reason=excluded.reason, dir=excluded.dir, title=excluded.title, claim=excluded.claim,
               artifacts=excluded.artifacts, registered_at=excluded.registered_at`,
      [sha, 1, 'present', null, dir, scan.title ?? trailers.demo?.claim ?? null,
       scan.claim ?? trailers.demo?.claim ?? null, scan.artifacts, new Date().toISOString()])
  } else if (trailers.demo?.status === 'skipped') {
    run(db, `insert into demos(sha, required, status, reason, registered_at) values(?,?,?,?,?)
             on conflict(sha) do update set required=0, status='skipped', reason=excluded.reason`,
      [sha, 0, 'skipped', trailers.demo.reason, new Date().toISOString()])
  } else {
    // Nothing said, nothing found. Guess whether one was owed so the CUI can nag.
    const required = looksLikeItNeedsADemo(files, trailers)
    run(db, `insert into demos(sha, required, status, reason, registered_at) values(?,?,?,?,?)
             on conflict(sha) do update set required=excluded.required,
               status=case when demos.status='present' then 'present' else 'missing' end`,
      [sha, required ? 1 : 0, 'missing',
       required ? 'no Demo: trailer and no demos/ directory found' : null,
       new Date().toISOString()])
  }

  return {
    sha, short_sha: meta.short_sha, subject: meta.subject,
    milestones: trailers.milestones, unknownKeys, coverage: coverageResult,
    demo: dir ? { dir, artifacts: scan.artifacts.length } : trailers.demo ?? { status: 'missing' },
    unparsed: !trailers.found,
  }
}

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|swift|sql|php|cs|scala|ex|exs)$/i
const NON_BEHAVIOUR = /(^|\/)(test|tests|__tests__|spec|docs?|\.github)\//i

function looksLikeItNeedsADemo(files, trailers) {
  if (trailers.milestones.some((m) => m.impact === 'enabled' || m.impact === 'progress')) return true
  const behavioural = files.filter(
    (f) => CODE_EXT.test(f.path) && !NON_BEHAVIOUR.test(f.path) && !/\.(test|spec)\./i.test(f.path),
  )
  if (!behavioural.length) return false
  const churn = behavioural.reduce((a, f) => a + f.insertions + f.deletions, 0)
  return churn >= 30
}

export function backfill(db, cfg, { limit = 200 } = {}) {
  const results = []
  for (const sha of G.listCommits(cfg.root, { limit }).reverse()) {
    try { results.push(ingestCommit(db, cfg, sha)) }
    catch (err) { results.push({ sha, error: err.message }) }
  }
  return results
}
