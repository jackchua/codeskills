# valent-mono

A starting point for projects I build with AI, designed around one failure mode: *the
codebase gets away from you*. Six weeks in, it works, and you can no longer say what's in it,
what's tested, or why any particular decision was made.

Four rules, enforced by tooling rather than by discipline:

1. **Product Function milestones before any code.** Agreed and vetted, not assumed.
2. **The repo structure is locked before any code.** Including every entry point and every
   runnable command, catalogued and searchable.
3. **Every commit is recorded** with its test coverage — project-wide *and* for the lines it
   added — and scored against the milestones.
4. **Every commit can explain itself**, with a visual demo proving it works and a walkthrough
   you can interrogate line by line.

Two halves:

| | |
| --- | --- |
| `plugins/cui/` | A Claude Code plugin — skills, slash commands and the hooks that enforce the gates. Install once, applies to every project. |
| `template/` | The CUI app itself, scaffolded into each project where the data lives. |

---

## Install

**The plugin**, once:

```bash
claude
> /plugin marketplace add ~/source/valent-mono
> /plugin install cui@valent
```

**Into a new project:**

```bash
mkdir ~/source/my-thing && cd ~/source/my-thing
node ~/source/valent-mono/scripts/scaffold.mjs
```

That copies in the CUI app, installs and builds it, creates `.cui/`, and installs a
`post-commit` git hook. Then, in Claude Code:

```
/pf              define the Product Function milestones
/blueprint       lock the structure, entry points and commands
                 …build…
/ship            commit: tests, coverage, demo, milestone scoring
npm run cui      the dashboard at http://localhost:4317
```

---

## The gates

Until milestones exist **and** the blueprint is locked, a `PreToolUse` hook refuses writes to
implementation files and tells Claude what to do instead. Docs, `.cui/`, `demos/` and `cui/`
stay writable.

This is the part that does the work. Everything else is reporting; this is what stops the
project from starting in the middle.

A project is only gated if it has a `.cui/` directory, so installing the plugin globally
leaves your other repos alone. `enforce: false` in `.cui/config.yaml` lifts it.

## What the CUI shows

**Overview** — milestone progress, coverage trend, demos owed, commits that landed unscored.

**Milestones** — each Product Function, its acceptance criteria and which commits moved it.
A milestone claimed `enabled` without an attached demo is flagged as unverified.

**Commits** — every commit with diff coverage, demo status and milestone impact. Three tabs
per commit:
- *Changes* — files with per-file diff coverage; open one to read it at that commit with the
  added lines highlighted, and click a line number to ask about it
- *Demo* — the evidence, rendered inline: terminal output, sample rows, charts, screenshots
- *Walkthrough* — generated on demand, with **ask about this** on every snippet

**Structure** — the locked layout with each directory's boundary rules, and every entry point.

**Commands** — everything runnable, searchable, with flags and examples. `⌘K` from anywhere.

## Skills

| Skill | Slash command | What it does |
| --- | --- | --- |
| `pf-milestones` | `/pf` | Interviews you, drafts milestones, refuses to rubber-stamp them |
| `repo-blueprint` | `/blueprint` | Derives structure from the milestones, locks it, generates `ARCHITECTURE.md` |
| `ship-commit` | `/ship` | Tests, coverage, demo decision, milestone scoring, commit |
| `commit-demo` | — | Decides if a commit needs a demo and produces one. Has playbooks per change type |
| `code-walkthrough` | `/walkthrough` | Medium-style walkthroughs, and pointed line-level answers |

## How it's built

No build step for the backend and no native dependencies: Node's built-in `node:sqlite`,
Hono for routing, and `yaml`. The dashboard is Vite + React. Walkthroughs and questions shell
out to `claude -p` with the repo as the working directory, so there is no API key to manage
and the model can read whatever file it needs to answer honestly.

Diff coverage is computed by intersecting the line numbers a commit added (`git diff
--unified=0`) with the executed-line records in the coverage artifact. lcov, Istanbul,
Cobertura, coverage.py and Go profiles are all parsed.

```
plugins/cui/
  skills/        five skills
  commands/      /pf /blueprint /ship /walkthrough /cui
  hooks/         gate.mjs (the PreToolUse gate), session-context.mjs
template/
  cui/
    bin/cui.mjs  the CLI
    src/server/  db, git, coverage, ingest, claude bridge, jobs, api
    web/         the dashboard
  .cui/examples/ shape references for the three YAML files
scripts/
  scaffold.mjs
```

## The `cui` CLI

It lives at `cui/bin/cui.mjs` in each project. Either use the npm scripts the scaffolder
adds (`npm run cui`, `npm run cui:status`, `npm run cui:doctor`), or alias it:

```bash
alias cui='node "$(git rev-parse --show-toplevel)/cui/bin/cui.mjs"'
```

```
cui serve [--dev]          the dashboard
cui status [--brief]       milestone progress and health, in the terminal
cui doctor [--preflight]   check the project is wired up correctly
cui ingest [--sha X]       record a commit (the git hook does this)
cui backfill               import existing history
cui coverage [run|report]  project and diff coverage
cui demo register|skip     attach evidence, or record why none was needed
cui walkthrough generate   generate one from the terminal
```
