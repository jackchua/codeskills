import { Hono } from 'hono'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative, resolve, sep } from 'node:path'
import { all, get, run, json as parseJson } from './db.mjs'
import * as G from './git.mjs'
import { sync } from './sync.mjs'
import { ingestCommit } from './ingest.mjs'
import { startWalkthrough, askQuestion, queueDepth } from './jobs.mjs'
import { claudeAvailable } from './claude.mjs'
import { loadCoverage, findCoverageFile } from './coverage.mjs'

const hydrate = (row, ...fields) => {
  if (!row) return row
  for (const f of fields) row[f] = parseJson(row[f], [])
  return row
}

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.json': 'application/json', '.csv': 'text/csv',
}

export function createApi(db, cfg) {
  const api = new Hono()

  // ---------------------------------------------------------------- overview
  api.get('/overview', (c) => {
    const meta = Object.fromEntries(all(db, `select key, value from meta`).map((r) => [r.key, r.value]))
    const milestones = all(db, `
      select m.*,
        (select count(*) from criteria where milestone_key = m.key) as criteria_total,
        (select count(*) from criteria where milestone_key = m.key and status = 'met') as criteria_met,
        (select count(*) from commit_milestones where milestone_key = m.key) as commit_count
      from milestones m order by m.position`)

    const commits = all(db, `
      select c.sha, c.short_sha, c.subject, c.committed_at, c.author_name,
             c.insertions, c.deletions, c.files_changed, c.unparsed,
             cov.project_pct, cov.diff_pct,
             d.status as demo_status, d.required as demo_required,
             w.status as walkthrough_status
      from commits c
      left join coverage cov on cov.sha = c.sha
      left join demos d on d.sha = c.sha
      left join walkthroughs w on w.sha = c.sha
      order by c.committed_at desc limit 12`)

    const trend = all(db, `
      select c.short_sha, c.committed_at, cov.project_pct, cov.diff_pct
      from coverage cov join commits c on c.sha = cov.sha
      where cov.project_pct is not null
      order by c.committed_at asc limit 200`)

    const health = {
      milestones_total: milestones.length,
      milestones_done: milestones.filter((m) => m.status === 'done').length,
      blueprint_locked: meta.blueprint_locked === '1',
      commits_total: get(db, `select count(*) n from commits`).n,
      demos_owed: get(db, `select count(*) n from demos where required = 1 and status = 'missing'`).n,
      unparsed_commits: get(db, `select count(*) n from commits where unparsed = 1`).n,
      walkthroughs_ready: get(db, `select count(*) n from walkthroughs where status = 'ready'`).n,
      coverage_file: findCoverageFile(cfg) ? relative(cfg.root, findCoverageFile(cfg)) : null,
      queue: queueDepth(),
    }

    return c.json({ meta, milestones, commits, trend, health })
  })

  // -------------------------------------------------------------- milestones
  api.get('/milestones', (c) =>
    c.json(all(db, `
      select m.*,
        (select count(*) from criteria where milestone_key = m.key) as criteria_total,
        (select count(*) from criteria where milestone_key = m.key and status = 'met') as criteria_met
      from milestones m order by m.position`).map((m) => hydrate(m, 'depends_on'))))

  api.get('/milestones/:key', (c) => {
    const key = c.req.param('key')
    const milestone = hydrate(get(db, `select * from milestones where key = ?`, [key]), 'depends_on')
    if (!milestone) return c.json({ error: 'unknown milestone' }, 404)
    return c.json({
      milestone,
      criteria: all(db, `select * from criteria where milestone_key = ? order by position`, [key]),
      commits: all(db, `
        select c.sha, c.short_sha, c.subject, c.committed_at, c.author_name,
               cm.impact, cm.note, cm.criteria_met, cov.diff_pct, d.status as demo_status, d.dir as demo_dir
        from commit_milestones cm
        join commits c on c.sha = cm.sha
        left join coverage cov on cov.sha = c.sha
        left join demos d on d.sha = c.sha
        where cm.milestone_key = ? order by c.committed_at desc`, [key])
        .map((r) => hydrate(r, 'criteria_met')),
    })
  })

  // ----------------------------------------------------------------- commits
  api.get('/commits', (c) => {
    const q = (c.req.query('q') ?? '').trim()
    const limit = Math.min(Number(c.req.query('limit') ?? 100), 500)
    const params = []
    let where = ''
    if (q) {
      where = `where c.subject like ? or c.body like ? or c.short_sha like ? or c.author_name like ?
               or exists (select 1 from commit_files f where f.sha = c.sha and f.path like ?)`
      params.push(...Array(5).fill(`%${q}%`))
    }
    params.push(limit)
    return c.json(all(db, `
      select c.sha, c.short_sha, c.subject, c.committed_at, c.author_name, c.branch,
             c.insertions, c.deletions, c.files_changed, c.unparsed, c.tests_status,
             cov.project_pct, cov.diff_pct,
             d.status as demo_status, d.required as demo_required, d.dir as demo_dir,
             w.status as walkthrough_status,
             (select group_concat(milestone_key || ':' || impact)
                from commit_milestones where sha = c.sha) as milestones
      from commits c
      left join coverage cov on cov.sha = c.sha
      left join demos d on d.sha = c.sha
      left join walkthroughs w on w.sha = c.sha
      ${where}
      order by c.committed_at desc limit ?`, params))
  })

  api.get('/commits/:sha', (c) => {
    const sha = c.req.param('sha')
    const commit = get(db, `select * from commits where sha = ? or short_sha = ?`, [sha, sha])
    if (!commit) return c.json({ error: 'unknown commit' }, 404)
    const full = commit.sha
    const demo = hydrate(get(db, `select * from demos where sha = ?`, [full]), 'artifacts')

    // Which lines this commit added, per file — lets the viewer highlight them and lets
    // the reader click one to ask a question about exactly that line.
    let added = new Map()
    try { added = G.addedLines(cfg.root, full) } catch { /* commit may be unreachable */ }

    return c.json({
      commit,
      files: all(db, `
        select f.*, fc.covered, fc.total, fc.pct, fc.diff_covered, fc.diff_total
        from commit_files f
        left join file_coverage fc on fc.sha = f.sha and fc.path = f.path
        where f.sha = ? order by f.path`, [full])
        .map((f) => ({ ...f, added_lines: [...(added.get(f.path) ?? [])] })),
      coverage: get(db, `select * from coverage where sha = ?`, [full]) ?? null,
      previous_coverage: get(db, `select project_pct from coverage where sha = ?`, [commit.parent_sha]) ?? null,
      milestones: all(db, `
        select cm.*, m.title, m.status as milestone_status
        from commit_milestones cm left join milestones m on m.key = cm.milestone_key
        where cm.sha = ?`, [full]).map((r) => hydrate(r, 'criteria_met')),
      demo,
      // markdown included: WalkthroughView renders this row directly when status is 'ready'
      walkthrough: get(db, `select sha, status, markdown, error, duration_ms, started_at, finished_at
                            from walkthroughs where sha = ?`, [full]) ?? null,
      question_count: get(db, `select count(*) n from questions where sha = ?`, [full]).n,
    })
  })

  api.get('/commits/:sha/diff', (c) => {
    const sha = c.req.param('sha')
    try { return c.text(G.diffText(cfg.root, sha)) }
    catch (err) { return c.json({ error: err.message }, 404) }
  })

  api.get('/commits/:sha/file', (c) => {
    const path = c.req.query('path')
    if (!path) return c.json({ error: 'path required' }, 400)
    const content = G.fileAtCommit(cfg.root, c.req.param('sha'), path)
    if (content === null) return c.json({ error: 'not found at this commit' }, 404)
    return c.json({ path, content })
  })

  // ------------------------------------------------------------ walkthroughs
  api.get('/commits/:sha/walkthrough', (c) => {
    const sha = G.resolveSha(cfg.root, c.req.param('sha'))
    return c.json(get(db, `select * from walkthroughs where sha = ?`, [sha]) ?? { sha, status: 'none' })
  })

  api.post('/commits/:sha/walkthrough', async (c) => {
    const sha = G.resolveSha(cfg.root, c.req.param('sha'))
    const force = (await c.req.json().catch(() => ({})))?.force === true
    return c.json(startWalkthrough(db, cfg, sha, { force }))
  })

  // --------------------------------------------------------------- questions
  api.get('/commits/:sha/questions', (c) => {
    const sha = G.resolveSha(cfg.root, c.req.param('sha'))
    return c.json(all(db, `select * from questions where sha = ? order by asked_at asc`, [sha]))
  })

  api.post('/commits/:sha/questions', async (c) => {
    const sha = G.resolveSha(cfg.root, c.req.param('sha'))
    const body = await c.req.json().catch(() => ({}))
    if (!body.question?.trim()) return c.json({ error: 'question required' }, 400)
    return c.json(askQuestion(db, cfg, sha, {
      question: body.question.trim(),
      file_path: body.file_path,
      line_start: body.line_start,
      line_end: body.line_end,
      selection: body.selection,
    }))
  })

  api.get('/questions/:id', (c) =>
    c.json(get(db, `select * from questions where id = ?`, [Number(c.req.param('id'))]) ?? { error: 'not found' }))

  // --------------------------------------------------------------- structure
  api.get('/structure', (c) => {
    const meta = Object.fromEntries(all(db, `select key, value from meta`).map((r) => [r.key, r.value]))
    const layout = all(db, `select * from layout order by position`)
      .map((r) => hydrate(r, 'owns', 'forbidden', 'serves'))
    for (const d of layout) d.exists = existsSync(join(cfg.root, d.path))
    const entrypoints = all(db, `select * from entrypoints order by position`)
      .map((r) => hydrate(r, 'serves'))
    for (const e of entrypoints) e.exists = !e.path || existsSync(join(cfg.root, e.path))
    return c.json({
      layout,
      entrypoints,
      stack: parseJson(meta.stack, {}),
      conventions: parseJson(meta.conventions, {}),
      locked: meta.blueprint_locked === '1',
      locked_at: meta.blueprint_locked_at || null,
    })
  })

  api.get('/commands', (c) => {
    const q = (c.req.query('q') ?? '').trim().toLowerCase()
    let rows = all(db, `select * from commands order by category, position`).map((r) => hydrate(r, 'args'))
    if (q) {
      rows = rows.filter((r) =>
        [r.name, r.command, r.description, r.category, r.entrypoint, r.example]
          .filter(Boolean).some((v) => String(v).toLowerCase().includes(q)) ||
        r.args.some((a) => `${a.flag} ${a.description}`.toLowerCase().includes(q)))
    }
    return c.json(rows)
  })

  // ------------------------------------------------------------------ search
  api.get('/search', (c) => {
    const q = (c.req.query('q') ?? '').trim()
    if (!q) return c.json([])
    const like = `%${q}%`
    const results = []
    for (const r of all(db, `select name, command, description, category, safe from commands
                             where name like ? or command like ? or description like ? limit 10`,
                        [like, like, like])) {
      results.push({ type: 'command', id: r.name, title: r.name, subtitle: r.command,
                     detail: r.description, badge: r.safe ? null : 'unsafe', href: `/commands?q=${encodeURIComponent(r.name)}` })
    }
    for (const r of all(db, `select id, kind, command, description from entrypoints
                             where id like ? or command like ? or description like ? limit 10`,
                        [like, like, like])) {
      results.push({ type: 'entrypoint', id: r.id, title: r.id, subtitle: r.command,
                     detail: r.description, badge: r.kind, href: '/structure' })
    }
    for (const r of all(db, `select key, title, status from milestones
                             where key like ? or title like ? limit 10`, [like, like])) {
      results.push({ type: 'milestone', id: r.key, title: `${r.key} — ${r.title}`,
                     badge: r.status, href: `/milestones/${r.key}` })
    }
    for (const r of all(db, `select sha, short_sha, subject from commits
                             where subject like ? or short_sha like ? or body like ?
                             order by committed_at desc limit 10`, [like, like, like])) {
      results.push({ type: 'commit', id: r.sha, title: r.subject, subtitle: r.short_sha,
                     href: `/commits/${r.sha}` })
    }
    for (const r of all(db, `select path, purpose from layout where path like ? or purpose like ? limit 5`,
                        [like, like])) {
      results.push({ type: 'directory', id: r.path, title: r.path, detail: r.purpose, href: '/structure' })
    }
    return c.json(results)
  })

  // ------------------------------------------------------------------- demos
  api.get('/demos', (c) =>
    c.json(all(db, `select d.*, c.subject, c.short_sha, c.committed_at from demos d
                    join commits c on c.sha = d.sha
                    where d.status = 'present' order by c.committed_at desc`)
      .map((r) => hydrate(r, 'artifacts'))))

  // Serves a file out of a demo directory. Path-traversal guarded.
  api.get('/demo-file', (c) => {
    const rel = c.req.query('path') ?? ''
    if (!rel.startsWith('demos/')) return c.json({ error: 'only demos/ is served' }, 403)
    const abs = resolve(cfg.root, rel)
    if (!abs.startsWith(resolve(cfg.root, 'demos') + sep)) return c.json({ error: 'forbidden' }, 403)
    if (!existsSync(abs) || !statSync(abs).isFile()) return c.json({ error: 'not found' }, 404)
    const ext = extname(abs).toLowerCase()
    const mime = MIME[ext]
    if (mime) {
      return new Response(readFileSync(abs), { headers: { 'content-type': mime } })
    }
    return c.text(readFileSync(abs, 'utf8'))
  })

  // ---------------------------------------------------------------- mutation
  api.post('/sync', (c) => c.json(sync(db, cfg)))

  api.post('/ingest', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    try { return c.json(ingestCommit(db, cfg, body.sha ?? 'HEAD')) }
    catch (err) { return c.json({ error: err.message }, 400) }
  })

  api.get('/health', async (c) => c.json({
    ok: true,
    root: cfg.root,
    git: G.isRepo(cfg.root),
    dirty: G.isRepo(cfg.root) ? G.isDirty(cfg.root) : null,
    claude: await claudeAvailable(cfg),
    coverage_file: findCoverageFile(cfg) ? relative(cfg.root, findCoverageFile(cfg)) : null,
    queue: queueDepth(),
  }))

  return api
}
