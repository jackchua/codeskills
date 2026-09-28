import { execFileSync } from 'node:child_process'

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

export function git(root, args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    if (allowFail) return null
    throw new Error(`git ${args.join(' ')} failed: ${(err.stderr || err.message || '').trim()}`)
  }
}

export const isRepo = (root) =>
  git(root, ['rev-parse', '--is-inside-work-tree'], { allowFail: true })?.trim() === 'true'

export const resolveSha = (root, ref = 'HEAD') =>
  git(root, ['rev-parse', ref]).trim()

export const currentBranch = (root) =>
  git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true })?.trim() ?? null

export function parentSha(root, sha) {
  const out = git(root, ['rev-list', '--parents', '-n', '1', sha], { allowFail: true })
  if (!out) return null
  const parts = out.trim().split(/\s+/)
  return parts.length > 1 ? parts[1] : null
}

const FIELD = '\u001f'
const RECORD = '\u001e'

export function commitMeta(root, sha) {
  const fmt = ['%H', '%h', '%s', '%an', '%ae', '%aI', '%B'].join(FIELD)
  const out = git(root, ['show', '-s', `--format=${fmt}`, sha])
  const [full, short, subject, authorName, authorEmail, date, body] = out.split(FIELD)
  return {
    sha: full.trim(),
    short_sha: short,
    subject,
    author_name: authorName,
    author_email: authorEmail,
    committed_at: date,
    // %B is the whole message; strip the subject line back off.
    body: (body ?? '').replace(/\r/g, '').split('\n').slice(1).join('\n').trim(),
    parent_sha: parentSha(root, sha),
  }
}

/** Files touched, with per-file insertion/deletion counts. */
export function commitFiles(root, sha) {
  const parent = parentSha(root, sha) ?? EMPTY_TREE
  const numstat = git(root, ['diff', '--numstat', '-M', `${parent}..${sha}`], { allowFail: true }) ?? ''
  const status = git(root, ['diff', '--name-status', '-M', `${parent}..${sha}`], { allowFail: true }) ?? ''

  const changeByPath = new Map()
  for (const line of status.split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    changeByPath.set(parts[parts.length - 1], parts[0][0])
  }

  const files = []
  for (const line of numstat.split('\n')) {
    if (!line.trim()) continue
    const [ins, del, ...rest] = line.split('\t')
    const path = rest[rest.length - 1]
    files.push({
      path,
      change: changeByPath.get(path) ?? 'M',
      // "-" means binary.
      insertions: ins === '-' ? 0 : Number(ins),
      deletions: del === '-' ? 0 : Number(del),
      binary: ins === '-',
    })
  }
  return files
}

/**
 * Line numbers ADDED by this commit, per file, in post-commit coordinates.
 * This is the basis of diff coverage: of the lines this commit introduced,
 * how many does the test suite actually execute?
 */
export function addedLines(root, sha) {
  const parent = parentSha(root, sha) ?? EMPTY_TREE
  const diff = git(root, ['diff', '--unified=0', '--no-color', '-M', `${parent}..${sha}`], {
    allowFail: true,
  }) ?? ''

  const byFile = new Map()
  let current = null

  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim()
      current = p === '/dev/null' ? null : p.replace(/^b\//, '')
      if (current && !byFile.has(current)) byFile.set(current, new Set())
      continue
    }
    if (!current) continue
    // @@ -old,oldCount +new,newCount @@
    const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/)
    if (m) {
      const start = Number(m[1])
      const count = m[2] === undefined ? 1 : Number(m[2])
      const set = byFile.get(current)
      for (let i = 0; i < count; i++) set.add(start + i)
    }
  }

  for (const [k, v] of byFile) if (v.size === 0) byFile.delete(k)
  return byFile
}

export function listCommits(root, { limit = 200, branch = null } = {}) {
  const args = ['log', `--max-count=${limit}`, '--format=%H']
  if (branch) args.push(branch)
  const out = git(root, args, { allowFail: true }) ?? ''
  return out.split('\n').map((s) => s.trim()).filter(Boolean)
}

export const fileAtCommit = (root, sha, path) =>
  git(root, ['show', `${sha}:${path}`], { allowFail: true })

export const diffText = (root, sha) => {
  const parent = parentSha(root, sha) ?? EMPTY_TREE
  return git(root, ['diff', '--no-color', '-M', `${parent}..${sha}`], { allowFail: true }) ?? ''
}

export const isDirty = (root) =>
  (git(root, ['status', '--porcelain'], { allowFail: true }) ?? '').trim().length > 0
