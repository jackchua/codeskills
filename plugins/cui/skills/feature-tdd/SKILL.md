---
name: feature-tdd
description: Build or change one registered feature test-first - write tests tagged with its ID, prove they fail for the right reason (cui tdd red), implement, prove the same tests pass (cui tdd green), run the full suite, then ship. Use whenever implementing a feature or fixing a bug in a CUI project, when the user runs /cui:tdd, says "build FR-…", "implement the next feature", or "fix this bug".
---

# Feature TDD

One feature at a time, test first, and recorded, so that "the test came first" is a
fact in `.cui/tdd/FR-X.json` rather than something the commit message says.

```
pick → plan check → write tests → cui tdd red → implement → cui tdd green → full suite → ship
```

## Step 0 — Pick the feature

- It must be in `.cui/features.yaml`. If the work isn't registered, register it first with
  the `feature-registry` skill (add the entry with a test plan — that's allowed without
  approval). **Never implement something with no ID.**
- Prefer features whose milestone is `in_progress` and whose `depends_on` milestones are
  done. Within a milestone, take `risk: high` features early.
- One feature per cycle. If you find yourself tagging two new IDs, finish one first.

For a **bug**: find the feature it breaks (or register the missing requirement), then the
cycle is the same — the red test reproduces the bug. Ship it as `Feature: FR-X fix`.

## Step 1 — Read the test plan, then write the tests

Read the feature's `test_plan` and the blueprint's test conventions. Write one test per
plan case, at the level the plan says, with `[FR-X]` in the test or suite name.

- Write the test against the **interface you wish existed**. If it doesn't exist yet, add
  the smallest stub that lets the test load and reach its assertions — an exported
  function that throws `not implemented`, a route returning 501. A test that fails on
  `Cannot find module` proves nothing, and `cui tdd red` will refuse it.
- Assert on behaviour the user would notice, with the boundary values from the plan.
- No `.skip`, no `.only`, no `expect(true)`, no snapshot of whatever the code currently
  returns.
- If writing a test reveals the plan is wrong or missing a case, add the case to the
  feature's `test_plan` now (adding is allowed).

## Step 2 — Red

```bash
node cui/bin/cui.mjs tdd red FR-X
```

It runs `feature_test_command` and requires at least one `[FR-X]` test to fail on an
assertion. **Read every failure message** and confirm each one fails *because the behaviour
is missing* — "expected 413, got 501" — not because the test itself is broken. If a failure
is for the wrong reason, fix the test and run red again.

If it says some tagged tests already pass: fine when extending an existing feature (they
guard current behaviour), but at least one test must describe the new behaviour and fail.

## Step 3 — Implement

Write the least code that makes the red tests pass, inside the blueprint's boundaries. Do not
edit the red tests to make them pass. If a test turns out to be wrong, say so, explain why,
and fix it — and expect to justify that in a `Test-Change:` trailer.

Run the feature's tests as often as you like while working:

```bash
node cui/bin/cui.mjs test   # or the feature_test_command directly
```

## Step 4 — Green

```bash
node cui/bin/cui.mjs tdd green FR-X
```

It requires every `[FR-X]` test to pass, **including every test that was red**. Deleting,
renaming or skipping a red test doesn't get you to green. On success it records the cycle
and promotes the feature from `planned` to `active`. Keep the trailer it prints.

## Step 4b — High-risk features: would the tests notice?

If the feature is `risk: high`:

```bash
node cui/bin/cui.mjs mutation --feature FR-X
```

Each surviving mutant is a concrete gap: "changing `>` to `>=` on `src/mail/limits.ts:14`
went unnoticed" means there's no test at the boundary. Add tests until the score meets the
threshold. Then it's the same cycle: they're tagged `[FR-X]` and must pass. Don't narrow
`source`, lower the threshold or mark mutants ignored to get past it; those are the user's
call (proposal).

## Step 5 — Nothing else broke

```bash
node cui/bin/cui.mjs test
node cui/bin/cui.mjs registry check --base origin/main --record
```

The first runs the whole suite. The second checks every registered feature, not just this
one, against the base branch, and raises the per-feature test-count baseline. If an
unrelated feature broke, that's a regression you caused: fix it before shipping. Don't
quarantine it and don't weaken its test. If you truly can't, stop and tell the user.

If there's no `origin/main` (no remote yet), use `--base main` or the commit you branched
from.

## Step 6 — Ship

Use `ship-commit` (`/cui:ship`). Include in the commit:
- the code and tests
- `.cui/tdd/FR-X.json` and `.cui/features.yaml` (the promotion)
- `.cui/registry-baseline.json` if `--record` raised it
- `.cui/mutation/FR-X.json` for a high-risk feature

and the trailer from Step 4:

```
Feature: FR-X red→green (2 red, 3 passing)
```

## When you're tempted to cut a corner

| Temptation | Do instead |
| --- | --- |
| Implement first, write tests after, run red against a stash | Don't. The red has to be real. |
| The old test for another feature now fails and "was wrong anyway" | Show the user the failure and the reason; fix it in its own commit with `Test-Change:` |
| Delete a slow or annoying test | `cui propose tests --feature FR-Y --min <n> --why "…"`; the user decides |
| It can't be tested automatically | Try a contract test, a fake, a snapshot. Then propose an exception (feature-registry, Step 5) |
| Two features at once because they share code | Two cycles. The second cycle's red will be short. |
