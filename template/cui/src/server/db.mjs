import { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
pragma journal_mode = wal;
pragma foreign_keys = on;

create table if not exists milestones (
  key text primary key,
  title text not null,
  why text,
  demo text,
  status text not null default 'not_started',
  depends_on text,
  dropped_reason text,
  position integer,
  updated_at text
);

create table if not exists criteria (
  id text primary key,
  milestone_key text not null,
  text text not null,
  status text not null default 'open',
  position integer
);

create table if not exists commits (
  sha text primary key,
  short_sha text,
  subject text,
  body text,
  author_name text,
  author_email text,
  committed_at text,
  branch text,
  parent_sha text,
  files_changed integer default 0,
  insertions integer default 0,
  deletions integer default 0,
  tests_status text default 'unknown',
  blueprint_note text,
  unparsed integer default 0,
  ingested_at text
);

create table if not exists commit_files (
  sha text not null,
  path text not null,
  change text,
  insertions integer default 0,
  deletions integer default 0,
  primary key (sha, path)
);

create table if not exists commit_milestones (
  sha text not null,
  milestone_key text not null,
  impact text not null,
  note text,
  criteria_met text,
  primary key (sha, milestone_key)
);

create table if not exists coverage (
  sha text primary key,
  project_pct real,
  project_covered integer,
  project_total integer,
  diff_pct real,
  diff_covered integer,
  diff_total integer,
  tool text,
  measured_at text
);

create table if not exists file_coverage (
  sha text not null,
  path text not null,
  covered integer default 0,
  total integer default 0,
  pct real,
  diff_covered integer default 0,
  diff_total integer default 0,
  primary key (sha, path)
);

create table if not exists demos (
  sha text primary key,
  required integer default 1,
  status text default 'missing',
  reason text,
  dir text,
  title text,
  claim text,
  artifacts text,
  registered_at text
);

create table if not exists walkthroughs (
  sha text primary key,
  status text default 'pending',
  markdown text,
  error text,
  duration_ms integer,
  started_at text,
  finished_at text
);

create table if not exists questions (
  id integer primary key autoincrement,
  sha text not null,
  file_path text,
  line_start integer,
  line_end integer,
  selection text,
  question text not null,
  answer text,
  status text default 'pending',
  error text,
  duration_ms integer,
  asked_at text,
  answered_at text
);

create table if not exists entrypoints (
  id text primary key,
  kind text,
  command text,
  path text,
  port text,
  description text,
  serves text,
  position integer
);

create table if not exists layout (
  path text primary key,
  purpose text,
  owns text,
  forbidden text,
  serves text,
  position integer
);

create table if not exists commands (
  name text primary key,
  command text,
  category text,
  description text,
  entrypoint text,
  safe integer default 1,
  args text,
  example text,
  outputs text,
  position integer
);

create table if not exists meta (
  key text primary key,
  value text
);

create index if not exists idx_commits_time on commits(committed_at desc);
create index if not exists idx_cm_milestone on commit_milestones(milestone_key);
create index if not exists idx_questions_sha on questions(sha);
create index if not exists idx_filecov_sha on file_coverage(sha);
`

let handle = null

export function openDb(cfg) {
  if (handle) return handle
  handle = new DatabaseSync(cfg.dbPath)
  handle.exec(SCHEMA)
  return handle
}

export function closeDb() {
  if (handle) {
    handle.close()
    handle = null
  }
}

/** Bind helper: node:sqlite rejects undefined and booleans, so normalise here. */
export function bind(value) {
  if (value === undefined) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value === null) return null
  if (typeof value === 'object') return JSON.stringify(value)
  return value
}

export function run(db, sql, params = []) {
  return db.prepare(sql).run(...params.map(bind))
}

export function all(db, sql, params = []) {
  return db.prepare(sql).all(...params.map(bind))
}

export function get(db, sql, params = []) {
  return db.prepare(sql).get(...params.map(bind))
}

export function setMeta(db, key, value) {
  run(db, `insert into meta(key, value) values(?, ?)
           on conflict(key) do update set value = excluded.value`, [key, String(value)])
}

export function getMeta(db, key) {
  return get(db, `select value from meta where key = ?`, [key])?.value ?? null
}

export const json = (v, fallback = null) => {
  if (v === null || v === undefined || v === '') return fallback
  try { return JSON.parse(v) } catch { return fallback }
}
