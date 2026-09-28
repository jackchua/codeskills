import { join } from 'node:path'
import { readYamlFile } from './config.mjs'
import { run, setMeta } from './db.mjs'

/** Loads the .cui YAML files into the database. The YAML is the source of truth. */
export function sync(db, cfg) {
  const report = { milestones: 0, criteria: 0, layout: 0, entrypoints: 0, commands: 0, warnings: [] }

  const pf = readYamlFile(join(cfg.cuiDir, 'product-functions.yaml'))
  if (pf) {
    const keep = new Set()
    const list = pf.milestones ?? []
    list.forEach((m, i) => {
      if (!m?.key) { report.warnings.push(`milestone #${i + 1} has no key — skipped`); return }
      keep.add(m.key)
      if (!m.demo) report.warnings.push(`${m.key} has no demo: line — how would you prove it?`)
      if (!m.acceptance?.length) report.warnings.push(`${m.key} has no acceptance criteria`)
      run(db, `insert into milestones(key, title, why, demo, status, depends_on, dropped_reason, position, updated_at)
               values(?,?,?,?,?,?,?,?,?)
               on conflict(key) do update set
                 title=excluded.title, why=excluded.why, demo=excluded.demo,
                 status=excluded.status, depends_on=excluded.depends_on,
                 dropped_reason=excluded.dropped_reason, position=excluded.position,
                 updated_at=excluded.updated_at`,
        [m.key, m.title ?? m.key, m.why, m.demo, m.status ?? 'not_started',
         m.depends_on ?? [], m.dropped_reason, i, new Date().toISOString()])
      report.milestones++

      run(db, `delete from criteria where milestone_key = ?`, [m.key])
      ;(m.acceptance ?? []).forEach((c, j) => {
        const id = c.id ?? `${m.key}.${j + 1}`
        run(db, `insert into criteria(id, milestone_key, text, status, position)
                 values(?,?,?,?,?)
                 on conflict(id) do update set text=excluded.text, status=excluded.status`,
          [id, m.key, c.text ?? String(c), c.status ?? 'open', j])
        report.criteria++
      })
    })
    // Milestones removed from the YAML entirely: keep the row (commits reference it)
    // but mark it so the UI can show it as stale rather than silently vanishing.
    for (const row of db.prepare(`select key from milestones`).all()) {
      if (!keep.has(row.key)) {
        run(db, `update milestones set status='dropped',
                 dropped_reason=coalesce(dropped_reason,'removed from product-functions.yaml')
                 where key=?`, [row.key])
      }
    }
    setMeta(db, 'product', pf.product ?? '')
    setMeta(db, 'north_star', pf.north_star ?? '')
    setMeta(db, 'out_of_scope', JSON.stringify(pf.out_of_scope ?? []))
  }

  const bp = readYamlFile(join(cfg.cuiDir, 'blueprint.yaml'))
  if (bp) {
    run(db, `delete from layout`)
    ;(bp.layout ?? []).forEach((d, i) => {
      if (!d?.path) return
      if (!d.forbidden?.length) {
        report.warnings.push(`layout ${d.path} has no "forbidden" rules — the boundary is undefined`)
      }
      run(db, `insert into layout(path, purpose, owns, forbidden, serves, position)
               values(?,?,?,?,?,?)`,
        [d.path, d.purpose, d.owns ?? [], d.forbidden ?? [], d.serves ?? [], i])
      report.layout++
    })
    run(db, `delete from entrypoints`)
    ;(bp.entrypoints ?? []).forEach((e, i) => {
      if (!e?.id) return
      run(db, `insert into entrypoints(id, kind, command, path, port, description, serves, position)
               values(?,?,?,?,?,?,?,?)`,
        [e.id, e.kind ?? 'cli', e.command, e.path, e.port == null ? null : String(e.port),
         e.description, e.serves ?? [], i])
      report.entrypoints++
    })
    setMeta(db, 'blueprint_locked', bp.locked ? '1' : '0')
    setMeta(db, 'blueprint_locked_at', bp.locked_at ?? '')
    setMeta(db, 'stack', JSON.stringify(bp.stack ?? {}))
    setMeta(db, 'conventions', JSON.stringify(bp.conventions ?? {}))
  } else {
    setMeta(db, 'blueprint_locked', '0')
  }

  const cmds = readYamlFile(join(cfg.cuiDir, 'commands.yaml'))
  if (cmds) {
    run(db, `delete from commands`)
    ;(cmds.commands ?? []).forEach((c, i) => {
      if (!c?.name) return
      run(db, `insert into commands(name, command, category, description, entrypoint, safe, args, example, outputs, position)
               values(?,?,?,?,?,?,?,?,?,?)
               on conflict(name) do update set command=excluded.command, category=excluded.category,
                 description=excluded.description, entrypoint=excluded.entrypoint, safe=excluded.safe,
                 args=excluded.args, example=excluded.example, outputs=excluded.outputs`,
        [c.name, c.command ?? c.name, c.category ?? 'other', c.description, c.entrypoint,
         c.safe === false ? 0 : 1, c.args ?? [], c.example, c.outputs, i])
      report.commands++
    })
  }

  setMeta(db, 'last_sync', new Date().toISOString())
  return report
}
