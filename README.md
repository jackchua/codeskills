# codeskills

A starting point for projects I build with AI, designed around one failure mode: *the
codebase gets away from you*. Six weeks in, it works, and you can no longer say what's in it,
what's tested, or why any particular decision was made.

Seven rules, enforced by tooling rather than by discipline:

1. **Product Function milestones before any code.** Agreed and vetted, not assumed.
2. **The repo structure is locked before any code.** Including every entry point and every
   runnable command, catalogued and searchable. Changing it afterwards takes your approval.
3. **Every feature is registered with an ID and a test plan**, and CI fails if an active
   feature has no passing test. Anything that can't be tested goes in an exceptions registry
   with an owner and an expiry.
4. **Features are built test-first, and the record proves it.** A red run, then a green run of
   the same tests, committed with the change.
5. **Obligations only go down with your sign-off.** The agent can add features, tests and test
   cases on its own. Removing or weakening any of them is a proposal you approve.
6. **High-risk features are mutation-tested.** Their tests must catch deliberately broken
   code, not just run it.
7. **Every commit is recorded and can explain itself**: coverage (project-wide *and* for the
   lines it added), milestone and feature impact, a visual demo (or your explicit waiver), and
   a walkthrough you can interrogate line by line.

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
> /plugin marketplace add ~/source/codeskills
> /plugin install cui@codeskills
```

**Into a new project**, from Claude Code in that directory:

```
> /cui:init
```

It runs the scaffolder that ships with the installed plugin, so the scaffolded app always
matches the plugin's skills. Without Claude Code, either of these does the same:

```bash
node ~/.claude/plugins/marketplaces/codeskills/scripts/scaffold.mjs   # the plugin's copy
npx github:jackchua/codeskills                                        # straight from GitHub
```

That copies in the CUI app, installs and builds it, creates `.cui/`, and installs a
`post-commit` git hook. Then, in Claude Code:

```
/cui:init            scaffold the CUI into this project
/cui:pf              define the Product Function milestones
/cui:blueprint       lock the structure, entry points and commands
/cui:features        register every feature with an ID and a test plan
/cui:tdd FR-MAIL-001 build one feature: red → implement → green → full suite
/cui:ship            commit: tests, registry check, coverage, demo, scoring
npm run cui          the dashboard at http://localhost:4317
```

The scaffolder also writes `.github/workflows/cui.yml` and `.github/CODEOWNERS`. Push to
GitHub, make the `cui` workflow a required check, and turn on "Require review from Code
Owners". Without that, the registry is only enforced on your machine.

---

## The gates

Until milestones exist **and** the blueprint is locked, a `PreToolUse` hook refuses writes to
implementation files and tells Claude what to do instead. Docs, `.cui/`, `demos/` and `cui/`
stay writable.

This is the part that does the work. Everything else is reporting; this is what stops the
project from starting in the middle.

After that, the same hook guards the project's contract for its whole life. It refuses:

- writes into a top-level directory the locked blueprint doesn't list
- any edit to the locked blueprint
- edits to `.cui/features.yaml` that remove, retire or demote a feature, or shrink a test plan
- marking an exception `approved`, or extending an approved exception's expiry
- direct writes to `.cui/approvals.log`, `.cui/registry-baseline.json`, `.cui/tdd/`, and the
  CI workflow and CODEOWNERS
- shell commands that write those files, or that run `cui approve` / `cui reject`

Each refusal tells Claude the legitimate route, usually `cui propose`, which leaves the change
waiting on the **Approvals** page for you.

A project is only gated if it has a `.cui/` directory, so installing the plugin globally
leaves your other repos alone. `enforce: false` in `.cui/config.yaml` lifts it.

## The feature registry

`.cui/features.yaml` gives every feature an ID (`FR-MAIL-002`), a milestone, and a test plan
by level (unit, integration, contract, e2e, collab, visual, perf). Tests carry the ID in
their name, `it('[FR-MAIL-002] rejects 25 MB + 1 byte', …)`, and any runner that writes
JUnit XML works. `cui registry check` fails when:

| Rule | Why |
| --- | --- |
| an `active` feature has no passing tagged test | the core promise |
| a tagged test fails | obviously |
| a test is tagged with an unregistered ID | typos silently untest a feature |
| an exception is unapproved or expired | exceptions are decisions, and temporary |
| a `done` milestone still has `planned` features | "done" means done |
| an active `risk: high` feature's mutation score is below its threshold, or it has never been measured | coverage proves code ran; mutation proves the tests would notice it breaking |
| **since the base ref**, a feature was removed/retired/demoted, a plan shrank, a feature ran fewer tagged tests, risk/threshold/source were lowered, an exception was approved, or the locked blueprint changed, without a matching entry in `.cui/approvals.log` | the ratchet: old features can't quietly stop being tested |

### Mutation testing and the nightly job

A `risk: high` feature lists the files it owns (`source:`). `cui mutation` runs your mutation
tool on them (Stryker, or anything that writes the mutation-testing-report-schema JSON) and
saves the score and surviving mutants to `.cui/mutation/FR-X.json`. Each pull request
mutation-tests only the high-risk features it touches.

`.github/workflows/cui-nightly.yml` mutation-tests every high-risk feature each night and looks
for exceptions that are expiring (within `exception_warning_days`, default 14), expired, or
still unapproved. It opens or updates one `cui-nightly` issue when something needs attention,
and closes it when everything is clean.

### Shipping without a demo

`/cui:ship no-demo` ships the commit with `Demo: waived`, without a reason and without
argument. The CUI shows the commit as "demo waived" and never counts it as an owed demo.

Test counts in the ratchet come from what actually ran in CI, checked against the
committed `.cui/registry-baseline.json` at the base. Deleting a test or adding `.skip` both
count as removal.

## What is enforced where

| Layer | Stops | Can be bypassed by |
| --- | --- | --- |
| PreToolUse hook | Claude editing protected files or approving itself, in-session | anything that isn't a Claude Code tool call; creative shell |
| `cui` CLI | malformed proposals, stale approvals, a lowered baseline | a human, deliberately |
| CI (`cui ci --base`) | every dropped obligation without an approval entry, on every PR | an approval entry written by hand |
| CODEOWNERS + required review | a hand-written approval entry merging unseen | an admin overriding branch protection |

The hook keeps honest sessions honest. CI plus required review is what actually guarantees it.

## What the CUI shows

**Overview** — milestone progress, coverage trend, demos owed, commits that landed unscored.

**Milestones** — each Product Function, its acceptance criteria and which commits moved it.
A milestone claimed `enabled` without an attached demo is flagged as unverified.

**Features** — the registry grouped by milestone, with each feature's state (passing,
failing, untested, excepted, planned), its tagged tests from the latest run, its test plan,
its red → green cycles, a per-commit pass/fail history, and the exceptions registry.

**Approvals** — proposals waiting on you, with a diff of what they change; proposed
exceptions with their reason and alternative verification; and the decision log.

**Commits** — every commit with diff coverage, demo status and milestone impact. Three tabs
per commit:
Commits that edit existing tests without a `Test-Change:` trailer are flagged, since that is
how a test gets weakened until it passes. `Feature: FR-X red→green` claims are marked verified
only when the committed cycle file shows the red and the green.

- *Changes* — files with per-file diff coverage; open one to read it at that commit with the
  added lines highlighted, and click a line number to ask about it
- *Demo* — the evidence, rendered inline: terminal output, sample rows, charts, screenshots
- *Walkthrough* — generated on demand, with **ask about this** on every snippet

**Structure** — the locked layout with each directory's boundary rules, and every entry point.

**Commands** — everything runnable, searchable, with flags and examples. `⌘K` from anywhere.

## Skills

| Skill | Slash command | What it does |
| --- | --- | --- |
| `pf-milestones` | `/cui:pf` | Interviews you, drafts milestones, refuses to rubber-stamp them |
| `repo-blueprint` | `/cui:blueprint` | Derives structure from the milestones, locks it, generates `ARCHITECTURE.md`; amendments by proposal |
| `feature-registry` | `/cui:features` | Turns acceptance criteria into registered features with test plans; wires the test runner; exceptions |
| `feature-tdd` | `/cui:tdd` | One feature test-first: tagged tests, `cui tdd red`, implement, `cui tdd green`, full suite |
| `ship-commit` | `/cui:ship` | Tests, registry check, coverage, demo decision, milestone and feature scoring, commit |
| `commit-demo` | — | Decides if a commit needs a demo and produces one. Has playbooks per change type |
| `code-walkthrough` | `/cui:walkthrough` | Medium-style walkthroughs, and pointed line-level answers |

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
  skills/        seven skills
  commands/      /cui:init /cui:pf /cui:blueprint /cui:features /cui:tdd /cui:ship /cui:walkthrough /cui:status
  hooks/         gate.mjs (the PreToolUse gate), session-context.mjs
template/
  cui/
    bin/cui.mjs  the CLI
    src/server/  db, git, coverage, ingest, registry, approvals, tdd, mutation, claude bridge, jobs, api
    web/         the dashboard
  ci/            the GitHub workflows (per-PR and nightly) and CODEOWNERS the scaffolder installs
  .cui/examples/ shape references for the YAML files
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

cui test                   run test_command (it must write JUnit XML)
cui registry check|list    the feature registry; --base REF adds the ratchet, --record the baseline
cui ci --base REF          everything CI enforces
cui tdd red|green FR-X     record a red → green cycle for one feature
cui mutation [--feature X] mutation-test risk: high features (--base REF: only those touched)
cui exceptions --expiring  exceptions expiring within the warning window
cui nightly                the nightly report (expiring exceptions, mutation, registry)
cui demo waive             record a commit as shipped without a demo, by choice
cui propose file|tests     write a proposal (agent)
cui approvals              what's waiting on a human
cui approve|reject ID      decide (human only; the hook blocks Claude)
cui ratchet accept --base  approve YAML changes you made by hand
```
