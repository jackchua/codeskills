import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml, parseDocument, stringify } from 'yaml'
import * as G from './git.mjs'
import { FILES, sha256, ratchet, readState, readApprovals, isCovered, describeItem, loadTestResults, evaluate, readMilestones, evaluateOptions } from './registry.mjs'

// Approvals are how obligations come down. The agent may add features, tests and proposed
// exceptions freely; removing or weakening any of them — or changing the locked blueprint —
// goes through a proposal that only a human approves, here or in the CUI. Every approval is
// appended to .cui/approvals.log, which is what CI checks the ratchet against.

const PROPOSALS = '.cui/proposals'

// Files a proposal may replace wholesale.
const PROPOSABLE = new Set([FILES.blueprint, FILES.features, FILES.exceptions, '.cui/product-functions.yaml'])

const now = () => new Date().toISOString()

export function approver(cfg) {
  return G.git(cfg.root, ['config', 'user.email'], { allowFail: true })?.trim() || process.env.USER || 'unknown'
}

const readText = (cfg, rel) => {
  const abs = join(cfg.root, rel)
  return existsSync(abs) ? readFileSync(abs, 'utf8') : null
}

export function listProposals(cfg, { all = false } = {}) {
  const dir = join(cfg.root, PROPOSALS)
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort().flatMap((f) => {
    try {
      const p = parseYaml(readFileSync(join(dir, f), 'utf8'))
      if (!p?.id) return []
      const proposal = { ...p, file: `${PROPOSALS}/${f}`, status: p.status ?? 'pending' }
      if (proposal.kind === 'file') {
        const current = readText(cfg, p.target)
        proposal.current = current
        proposal.stale = p.base_sha256 && sha256(current ?? '') !== p.base_sha256
      }
      return all || proposal.status === 'pending' ? [proposal] : []
    } catch { return [] }
  })
}

/** Everything waiting on a human: pending proposals and proposed exceptions. */
export function pendingApprovals(cfg) {
  const state = readState(cfg)
  return {
    proposals: listProposals(cfg),
    exceptions: state.exceptions.filter((e) => e?.status === 'proposed'),
  }
}

/** Writes a proposal file. Used by `cui propose`; the agent may also write one by hand. */
export function createProposal(cfg, p) {
  const id = p.id ?? `${now().slice(0, 10)}-${(p.title ?? 'change').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}`
  if (p.kind === 'file') {
    if (!PROPOSABLE.has(p.target)) throw new Error(`proposals can replace ${[...PROPOSABLE].join(', ')} — not ${p.target}`)
    if (p.content === undefined) throw new Error('a file proposal needs the full proposed content')
  } else if (p.kind === 'tests') {
    if (!p.feature || p.min === undefined) throw new Error('a tests proposal needs feature and min')
  } else throw new Error('kind must be file or tests')
  if (!p.why || String(p.why).split(/\s+/).length < 4) throw new Error('say why, in a sentence someone could disagree with')

  const body = {
    id, kind: p.kind, title: p.title, why: p.why, status: 'pending', created_at: now(),
    ...(p.kind === 'file'
      ? { target: p.target, base_sha256: sha256(readText(cfg, p.target) ?? ''), content: p.content }
      : { feature: p.feature, min: Number(p.min) }),
  }
  mkdirSync(join(cfg.root, PROPOSALS), { recursive: true })
  const rel = `${PROPOSALS}/${id}.yaml`
  if (existsSync(join(cfg.root, rel))) throw new Error(`${rel} already exists`)
  writeFileSync(join(cfg.root, rel), stringify(body, { lineWidth: 0, blockQuote: 'literal' }))
  return { id, file: rel }
}

/** The part of a ratchet item an approval needs to match it later. */
const allowFor = ({ kind, id, hash, to, expires, globs }) => ({
  kind, id,
  ...(hash ? { hash } : {}), ...(to !== undefined ? { to } : {}),
  ...(expires !== undefined ? { expires } : {}), ...(globs ? { globs } : {}),
})

function log(cfg, entry) {
  appendFileSync(join(cfg.root, FILES.approvals), `${JSON.stringify(entry)}\n`)
}

function setProposalStatus(cfg, proposal, status, by, note) {
  const doc = parseDocument(readFileSync(join(cfg.root, proposal.file), 'utf8'))
  doc.set('status', status)
  doc.set('decided_by', by)
  doc.set('decided_at', now())
  if (note) doc.set('note', note)
  writeFileSync(join(cfg.root, proposal.file), doc.toString({ lineWidth: 0, flowCollectionPadding: false }))
}

function editBaseline(cfg, fn) {
  const path = join(cfg.root, FILES.baseline)
  let b = { version: 1, features: {} }
  try { if (existsSync(path)) b = JSON.parse(readFileSync(path, 'utf8')) } catch { /* rebuild */ }
  fn(b.features)
  writeFileSync(path, `${JSON.stringify(b, null, 2)}\n`)
}

function setExceptionStatus(cfg, id, status) {
  const path = join(cfg.root, FILES.exceptions)
  const doc = parseDocument(readFileSync(path, 'utf8'))
  const list = doc.get('exceptions')
  const node = list?.items?.find((n) => n.get?.('id') === id)
  if (!node) throw new Error(`no exception ${id} in ${FILES.exceptions}`)
  node.set('status', status)
  writeFileSync(path, doc.toString({ lineWidth: 0, flowCollectionPadding: false }))
  return node.toJSON()
}

/**
 * Approves a proposal or a proposed exception. The approval records exactly which ratchet
 * items it allows, so CI can tell an approved retirement from a quiet deletion.
 */
export function approve(cfg, id, { by = approver(cfg), note = null } = {}) {
  const state = readState(cfg)
  const ex = state.exceptions.find((e) => e?.id === id)
  if (ex) {
    if (ex.status === 'approved') throw new Error(`${id} is already approved`)
    const updated = setExceptionStatus(cfg, id, 'approved')
    const allows = [{ kind: 'exception-approved', id, expires: String(updated.expires ?? '') }]
    log(cfg, { at: now(), by, decision: 'approved', subject: id, kind: 'exception', title: `${ex.feature}: ${ex.reason ?? ''}`.trim(), note, allows })
    return { kind: 'exception', id, allows }
  }

  const proposal = listProposals(cfg, { all: true }).find((p) => p.id === id)
  if (!proposal) throw new Error(`nothing pending called ${id}`)
  if (proposal.status !== 'pending') throw new Error(`${id} is already ${proposal.status}`)

  let allows = []
  if (proposal.kind === 'file') {
    if (proposal.stale) {
      throw new Error(`${proposal.target} changed after ${id} was written — ask for the proposal to be redone against the current file`)
    }
    const before = state
    writeFileSync(join(cfg.root, proposal.target), proposal.content)
    const after = readState(cfg)
    // The approval covers what this change drops; tests for a dropped feature go with it.
    allows = ratchet({ ...before, blueprint: { ...before.blueprint, locked: before.blueprint.locked || proposal.target === FILES.blueprint } }, after)
      .map(allowFor)
    const dropped = new Set(allows.filter((a) => a.kind === 'feature-removed' || a.kind === 'feature-retired').map((a) => a.id))
    if (dropped.size) editBaseline(cfg, (f) => { for (const fid of dropped) delete f[fid] })
  } else if (proposal.kind === 'tests') {
    allows = [{ kind: 'tests-removed', id: proposal.feature, to: proposal.min }]
    editBaseline(cfg, (f) => { f[proposal.feature] = { tests: proposal.min } })
  }

  setProposalStatus(cfg, proposal, 'approved', by, note)
  log(cfg, { at: now(), by, decision: 'approved', subject: id, kind: proposal.kind, title: proposal.title, note, allows })
  return { kind: proposal.kind, id, allows, target: proposal.target ?? null }
}

export function reject(cfg, id, { by = approver(cfg), note = null } = {}) {
  const state = readState(cfg)
  const ex = state.exceptions.find((e) => e?.id === id)
  if (ex) {
    setExceptionStatus(cfg, id, 'rejected')
    log(cfg, { at: now(), by, decision: 'rejected', subject: id, kind: 'exception', note, allows: [] })
    return { kind: 'exception', id }
  }
  const proposal = listProposals(cfg, { all: true }).find((p) => p.id === id)
  if (!proposal) throw new Error(`nothing pending called ${id}`)
  setProposalStatus(cfg, proposal, 'rejected', by, note)
  log(cfg, { at: now(), by, decision: 'rejected', subject: id, kind: proposal.kind, title: proposal.title, note, allows: [] })
  return { kind: proposal.kind, id }
}

/**
 * For changes a human made directly in the YAML: records approvals for every uncovered
 * ratchet item between `base` and the working tree. Refuses nothing — it is the human's call.
 */
export function acceptRatchet(cfg, base, { by = approver(cfg), note = null } = {}) {
  const baseSha = G.resolveSha(cfg.root, base)
  const head = readState(cfg)
  const evaluation = evaluate(head, loadTestResults(cfg), readMilestones(cfg), evaluateOptions(cfg))
  const items = ratchet(readState(cfg, baseSha), head, evaluation).filter((i) => !isCovered(i, readApprovals(cfg)))
  if (!items.length) return { items: [] }
  const allows = items.map(allowFor)
  for (const a of allows.filter((x) => x.kind === 'tests-removed')) {
    editBaseline(cfg, (f) => { f[a.id] = { tests: a.to } })
  }
  log(cfg, { at: now(), by, decision: 'approved', subject: `ratchet since ${baseSha.slice(0, 7)}`, kind: 'manual', note, allows })
  return { items: items.map((i) => ({ ...i, text: describeItem(i) })) }
}
