---
name: feature-registry
description: Build, extend and amend the feature registry (.cui/features.yaml) - every feature or requirement gets an ID and a test plan, tests carry the ID, and CI fails when an active feature has no passing test. Use after the blueprint is locked, when the user runs /cui:features, before implementing anything not yet registered, when a milestone is added or re-scoped, or when something genuinely cannot be tested automatically and needs an exceptions-registry entry.
---

# Feature registry

Milestones say what the product does. The registry says, feature by feature, **how we will
know it still does it.** Each entry has a permanent ID, a parent milestone, and a test plan.
Tests carry the ID in their name. `cui registry check` — run locally and in CI — fails when:

- an `active` feature has no passing test tagged with its ID
- a tagged test fails
- a test is tagged with an ID that isn't registered (typos count)
- an exception is unapproved or expired
- since the base branch, a feature was removed/retired/demoted, a test plan shrank, a feature
  ran fewer tagged tests, an exception was approved, or the locked blueprint changed —
  **without a matching entry in `.cui/approvals.log`**

That last rule is the point. Old features can't quietly stop being tested, because every
obligation the registry holds can only go up unless the user signs it down.

Prerequisites: milestones approved, blueprint locked. If not, run `pf-milestones` /
`repo-blueprint` first.

## Step 1 — Wire the test runner (once)

The registry reads **JUnit XML**. Every mainstream runner can write it. Before registering
anything, make sure:

1. `test_command` in `.cui/config.yaml` runs the whole suite and writes JUnit XML to a path
   matched by `test_results` (default `test-results/**/*.xml`).
2. `feature_test_command` runs one feature's tests, with `{id}` substituted — this is what
   `cui tdd` uses, so it must be fast.
3. The runner's output keeps the `[FR-…]` tag visible in the test name, classname, or an
   enclosing suite name.
4. If any feature will be `risk: high`, set `mutation_command` (e.g. Stryker). `{files}` is
   replaced with the feature's `source` globs. The tool must write
   mutation-testing-report-schema JSON to `mutation_report`.

Per-runner setup, including mutation tools, is in
[references/runner-setup.md](references/runner-setup.md). Verify it:

```bash
node cui/bin/cui.mjs test && ls test-results/
```

Add the test directories (e.g. `tests/e2e`) to the blueprint if they aren't there — the gate
blocks new top-level directories.

## Step 2 — Derive features from acceptance criteria

Read `.cui/product-functions.yaml`. Each acceptance criterion becomes **one or more**
features. A feature is the smallest unit of behaviour a user would notice breaking.

- Good: `FR-MAIL-002 Attachments up to 25 MB`, `FR-DOCS-011 Two users editing the same
  paragraph converge to the same text`.
- Bad: `FR-MAIL-009 Mail backend`, `FR-CORE-001 Database layer`. Infrastructure is not a
  feature; it is tested through the features that need it.

**IDs:** `FR-<AREA>-<NNN>`, upper case, three digits. `AREA` is a short product area
(`MAIL`, `CAL`, `DRIVE`, `DOCS`, `SHEETS`, `AUTH`, `SHARE`, `ADMIN`). IDs are permanent —
never renumbered, never reused, even after retirement.

Also register **cross-cutting requirements** as features in their own area — they break as
easily as features do:

- `FR-SHARE-…` permissions and sharing rules (who can see/edit what, across every app)
- `FR-AUTH-…` sessions, sign-in, account boundaries
- `FR-PERF-…` budgets with a number ("inbox of 10k messages renders first page < 300 ms")
- `FR-A11Y-…` keyboard and screen-reader paths for core flows

## Step 3 — Write a test plan per feature

Each case is one behaviour, phrased so it can fail. Choose the **lowest level that would
catch the bug**, and add a higher level only for what the lower one can't see:

| Level | Use for |
| --- | --- |
| `unit` | pure logic: parsing, validation, permission rules, formula evaluation |
| `integration` | one service with its real storage: a send actually lands in two mailboxes |
| `contract` | the seam between two apps or services: Drive's share API as Mail calls it |
| `e2e` | a user journey through the real UI (Playwright). Few, slow, high value |
| `collab` | two or more clients at once: concurrent edits converge, presence updates |
| `visual` | rendered output compared against a snapshot |
| `perf` | a budget with a number, measured in CI |
| `manual` | only with an exception (Step 5) |

Rules of thumb for a Workspace-shaped product:
- Anything touching **permissions, data loss or other users' data** is `risk: high` and gets
  at least two levels (e.g. unit for the rule + integration or e2e for enforcement).
- Every `risk: high` feature lists the files it owns in `source:` (globs). Once it is active
  it must meet a **mutation score** (`mutation_threshold`, default 60%): the mutation tool
  makes small changes to those files, and enough of them must make a test fail. Line coverage
  only shows the code *ran*. This shows the tests would *notice* if it were wrong. Keep
  `source` tight. Claiming shared utility files puts their survivors on this feature.
- Every app-to-app seam (attach-from-Drive, calendar invite by mail, share dialog everywhere)
  gets a `contract` case on **both** sides. This is where new features break old ones.
- Real-time features get a `collab` case with at least two clients and a forced conflict.
- Each case should name its boundary values: "25 MB accepted, 25 MB + 1 byte rejected", not
  "large files rejected".

## Step 4 — Vet, then write

Present the registry as a table grouped by milestone: ID, title, levels, risk. Ask:

> Which of these is missing, mis-sliced, or tested at the wrong level?

Then write `.cui/features.yaml` (shape: `.cui/examples/features.yaml`). New features start
as `status: planned`; `cui tdd green` promotes them to `active`. Then:

```bash
node cui/bin/cui.mjs registry check     # planned features pass; this validates the file
node cui/bin/cui.mjs sync
```

Tell the user how many features per milestone, how many are `risk: high`, and that the next
step is building them one at a time with the `feature-tdd` skill (`/cui:tdd FR-…`).

## Amending

The rule the plugin's gate enforces: **you may add obligations; removing one is the user's
call.**

| Change | How |
| --- | --- |
| Add a feature, add a test-plan case | Edit `.cui/features.yaml` directly |
| `planned` → `active` | `cui tdd green` does it; editing it directly is also allowed |
| Remove, retire or demote a feature; drop a plan case | Proposal: draft the whole new file, then `node cui/bin/cui.mjs propose file --target .cui/features.yaml --from <draft> --title "…" --why "…"` |
| Delete or merge tagged tests so a feature runs fewer | `node cui/bin/cui.mjs propose tests --feature FR-X --min <n> --title "…" --why "…"` |
| Mark a feature `risk: high`, raise `mutation_threshold`, add `source` globs | Edit directly |
| Lower risk or a threshold, remove a `source` glob | Proposal (a file proposal for `.cui/features.yaml`) |

Proposals do nothing until the user approves them (`cui approve <id>` or the CUI Approvals
page). You cannot approve them: the gate blocks it. Tell the user a proposal is waiting and
why, then carry on with other work.

A `why` is a sentence someone could disagree with. "No longer needed" is not one; "attachments
now go through Drive links (PF-3), so inline upload is dead code" is.

## Step 5 — Exceptions (rare, tracked, temporary)

Some things really can't be tested automatically yet: pixel-exact print output before a visual
harness exists, a third-party OAuth screen, a test that is flaky for a reason outside your
control. Those go in `.cui/exceptions.yaml` (shape: `.cui/examples/exceptions.yaml`) with:

- `reason` — why an automated test isn't possible **now**
- `verification` — what verifies it instead, concretely (a checklist path, a monitored metric)
- `owner` and `expires` — no more than 90 days out. An expired exception fails CI.
- `status: proposed` — always. Only the user sets `approved`. The gate refuses if you try.
- `test:` — for `flaky` only: quarantines just the tests whose name contains this text,
  leaving the feature's other tests enforced.

Before proposing an exception, try once more to test it: a contract test against a recorded
fixture, a visual snapshot, a fake for the third party. Say in `reason` what you tried.
"Hard to test" is not a reason.

## Anti-patterns

- Registering features **after** writing the code. The registry comes first; code without
  an ID is code nobody can tell is still working.
- One feature per milestone. If a milestone has three acceptance criteria, it has at least
  three features.
- Test plans that restate the title ("sending works"). Name the behaviour and its boundary.
- Tagging a broad smoke test with ten feature IDs to make them all pass. A tag means "this
  test fails if that feature breaks" — be honest about it.
- Proposing an exception to get CI green tonight.
