---
name: ship-commit
description: Commit work the CUI way - run tests and coverage, decide and produce a visual demo, score the change against PF milestones, then commit and ingest into the CUI. Use whenever the user asks to commit, ship, or "save this", runs /ship, or when a chunk of implementation is finished and ready to land.
---

# Ship a commit

A commit that lands without evidence is a commit you will not understand in three weeks.
This skill makes every commit carry its own proof: what it does, whether it's tested, what
it looks like working, and which Product Function it moved.

Never run a bare `git commit` for implementation work. Use this flow.

## Preconditions

Run `node cui/bin/cui.mjs doctor --preflight`. It checks that milestones exist, the blueprint is locked, and
the working tree has something to commit. If it fails, fix that first.

## Step 1 — Read the change before describing it

```bash
git status --short
git diff --stat
git diff            # actually read it
```

Do not describe a diff you haven't read. If the diff is larger than roughly 400 lines
across unrelated concerns, **stop and split it**. Two commits with clear stories beat one
commit nobody can review. Say so and propose the split.

## Step 2 — Tests and coverage

Run the project's test command from `.cui/commands.yaml` (category `test`), with coverage on.
If coverage isn't wired up yet, wire it up now — it's a one-time cost and every later commit
benefits.

```bash
node cui/bin/cui.mjs coverage run          # runs the configured test+coverage command
node cui/bin/cui.mjs coverage report       # parses lcov / cobertura / coverage.json / go cover
```

`node cui/bin/cui.mjs coverage report` gives you two numbers, and you care about both:

- **Project coverage** — the usual line percentage, trended in the CUI.
- **Diff coverage** — of the lines *this commit added*, how many are executed by tests.
  This is the honest number. A commit can raise project coverage while adding untested code.

If diff coverage is below 80%, either write the missing tests or state plainly in the commit
body why those lines are untestable (generated code, thin I/O adapter, throwaway script).
Do not silently ship untested logic. Tell the user the number before committing.

If tests fail: stop. Report the failure output. Do not commit red tests to "fix in the next
one" unless the user explicitly says to, and if they do, record it as `tests: failing` in the
commit trailer so the CUI badges it.

## Step 3 — Decide whether this commit needs a demo

Invoke the `commit-demo` skill. It owns the rubric and the production of the artifact. Come
back here with either a demo directory or a recorded reason for skipping.

Do not skip this step's *reasoning* even when the answer is obviously no — the CUI records
the reason, and "no demo, and here's why" is itself useful history.

## Step 4 — Score against PF milestones

For every milestone the change touches, decide the impact honestly:

| Impact | Means |
| --- | --- |
| `enabled` | The milestone is now fully demonstrable. Every acceptance criterion is met **and** a demo proves it. |
| `progress` | Moved forward, specific criteria now met, not finished. |
| `groundwork` | Required for the milestone but demonstrates nothing on its own. |
| `none` | Refactor, tooling, docs, chore. Perfectly fine — say so. |

Be strict about `enabled`. Claiming a milestone is done when it merely compiles is the single
most damaging thing you can record here, because it's the number the user trusts. If any
acceptance criterion is unmet, it is `progress`.

Name the specific acceptance criteria this commit satisfies by id (`PF-2.3`), not by vibes.

## Step 5 — Write the commit message

```
<type>(<scope>): <imperative subject, <=72 chars>

<Why this change exists. What a reader six weeks from now needs to know that
the diff cannot tell them. Two to five lines.>

PF: PF-2 progress (PF-2.1, PF-2.3 met)
PF: PF-4 groundwork
Coverage: project 78.4% (+1.2), diff 91.3%
Demo: demos/004-synthetic-orders - 500 rows in Postgres, realism checks pass
Blueprint: unchanged
```

Trailer rules:
- One `PF:` line per milestone touched. `PF: none` if genuinely none — never omit the line.
- `Coverage:` always present, both numbers.
- `Demo:` is either a path plus one-line claim, or `Demo: skipped - <reason>`.
- `Blueprint:` is `unchanged` or describes the amendment.

These trailers are parsed by `node cui/bin/cui.mjs ingest`. Keep the format exact. If you must deviate, the
CUI will flag the commit as `unparsed` rather than guess.

## Step 6 — Commit and ingest

```bash
git add <specific paths>       # never `git add -A` without reading what it picks up
git commit -m "$(cat <<'MSG'
<message>
MSG
)"
```

The installed `post-commit` git hook runs `node cui/bin/cui.mjs ingest` automatically in the background. If
the hook isn't installed (`node cui/bin/cui.mjs doctor` will say), run it yourself:

```bash
node cui/bin/cui.mjs ingest --sha HEAD
```

Ingest records the commit, its stats, both coverage numbers, the demo artifacts, and the
milestone scoring into the CUI database.

## Step 7 — Report

Give the user four lines, no more:

```
Committed a1b2c3d - feat(seed): synthetic order generator
Coverage  project 78.4% (+1.2)  diff 91.3%
PF-2 progress (PF-2.1, PF-2.3 met) - 2 of 4 criteria remain
Demo      demos/004-synthetic-orders/demo.md
```

If a milestone flipped to `enabled`, say that loudly — it's the thing they care about.
Mention the CUI URL (`http://localhost:4317/commits/a1b2c3d`) only when there's something
worth looking at: a demo, a milestone change, or a coverage regression.

## Push

Only when asked. Branch first if on the default branch.

## Anti-patterns

- `git add -A` followed by a message describing only half of what got staged.
- Reporting coverage as "good" instead of as a number.
- Marking `enabled` because the happy path worked once by hand.
- Skipping the demo because it's tedious, then writing `Demo: skipped - trivial` on a commit
  that adds a user-facing feature.
- Committing before the tests finish running.
