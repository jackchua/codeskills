---
name: commit-demo
description: Decide whether a commit needs a visual demo and produce one that proves the functionality actually works. Use during /ship, when asked to "prove it works", "show me", or "demo this", and whenever a commit adds or changes observable behaviour - data generation, API endpoints, UI, CLI output, migrations, integrations.
---

# Commit demos

A demo is evidence, produced automatically, that the thing you just built does what you said.
It is not a screenshot of your editor. It is not the test output. It is the artifact a
sceptical person would ask for.

The bar: **could someone who doesn't trust you look at this and believe the feature works?**

## Step 1 — Decide if a demo is required

Work through this in order. Stop at the first match.

**Demo required** when the commit:
- adds or changes anything a user or caller can observe — UI, endpoint, CLI output, file format
- generates, migrates, imports or transforms data
- integrates with an external system
- changes an algorithm's output (ranking, pricing, parsing, inference)
- fixes a bug — the demo is the reproduction, now passing
- claims `enabled` or `progress` on a PF milestone

**Demo not required** when the commit is *only*:
- a pure refactor with identical observable behaviour (say how you know it's identical)
- tests, types, comments, docs, formatting
- dependency bumps with no behaviour change
- build/CI/tooling config
- work-in-progress groundwork that demonstrates nothing yet

**Borderline?** Demo it. The cost is a few minutes; the cost of an unproven feature is
discovering in week six that it never worked.

Record the decision either way. When skipping, the reason goes in the commit trailer
(`Demo: skipped - pure refactor, output byte-identical on the fixture corpus`) and must be
specific enough to argue with. "Trivial" is not a reason.

## Step 2 — Choose the artifact that actually proves it

Match the evidence to the claim. See `references/demo-playbooks.md` for concrete recipes per
change type (database, API, CLI, UI, data pipeline, bug fix, performance, integration).

The general rule: show **the state of the world after the change**, from outside the code
that produced it. Query the database with `psql`, not with your own ORM wrapper. Hit the
endpoint with `curl`, not with your own client. Read the file with `head`, not your parser.
Evidence produced by the code under test is not evidence.

## Step 3 — Prove the quality, not just the existence

This is what separates a real demo from a box-tick. Whatever you built, state its
correctness criteria up front and then check them.

For the user's canonical example — synthetic data in Postgres — existence is `SELECT count(*)`.
That's the easy half. Realism is:

- distributions: is `order_total` log-normal-ish, or did everything land on $50?
- cardinality: how many distinct customers, and is the orders-per-customer curve plausible?
- referential integrity: zero orphans, checked with a join
- temporal shape: do timestamps spread across the intended range, with a weekday/weekend
  pattern if that's realistic?
- nulls and edge cases: present at plausible rates, not zero
- uniqueness: emails unique, no duplicate primary business keys
- the tells: no `test1@test.com`, no 1970 timestamps, no repeating `Lorem ipsum`

Write these as **assertions that can fail**, run them, and show the output. A realism check
that always passes is decoration.

## Step 4 — Produce the demo

Everything lands in `demos/<NNN>-<slug>/` — a zero-padded sequence number and a short
kebab-case name. Not the commit sha: you are creating this *before* the commit exists, and a
demo that has to be renamed after the fact never gets renamed. The `Demo:` trailer ties it to
the commit, and the CUI resolves it from there.

```
demos/004-synthetic-orders/
  demo.md          # the narrative - required
  run.sh           # regenerates every artifact below - required
  01-row-count.txt
  02-sample-rows.md
  03-realism-checks.txt
  04-distribution.png
```

Use the next free number: `ls demos/ | tail -1`.

**`run.sh` is required and must be re-runnable.** A demo you can't reproduce is a claim, not
evidence. It should exit non-zero if any check fails. Assume a clean checkout and a running
dependency stack; document what it needs at the top.

**`demo.md` structure:**

```markdown
# PF-2: Synthetic order data in Postgres

**Milestone:** PF-2 (progress) · **Run:** `bash demos/004-synthetic-orders/run.sh`

## Claim
`npm run db:seed -- --rows 500` populates `customers` and `orders` with data that passes
realism checks, in under 10 seconds.

## Evidence

### 1. The rows exist
...psql output, verbatim...

### 2. They look real
...sample table...

### 3. They pass the realism checks
...assertion output, each with PASS/FAIL...

### 4. Distribution
![order totals](04-distribution.png)

## Limits
Only two tables so far. No returns or refunds yet - that's PF-3.
```

The **Limits** section is not optional. An honest demo says what it does *not* prove. It is
the section that keeps the CUI trustworthy.

## Step 5 — Capture

Prefer, in this order:

1. **Verbatim terminal output** — cheap, diffable, unfakeable-looking. Tee it to a file.
2. **Markdown tables** — for sample rows; readable in the CUI without tooling.
3. **Static images** — charts (distributions, trends) written as PNG/SVG into the demo dir.
4. **Screenshots** — for UI. Use whatever browser automation the project already has; if
   none, Playwright's `page.screenshot()` is the lowest-friction addition.
5. **Recorded terminal sessions** — `asciinema rec` when the *sequence* matters.
6. **Short video** — only for interaction flows nothing else captures.

Keep artifacts small. Downsample images, truncate logs to the informative part, cap sample
rows at ~20. Demos live in git forever; a 4MB PNG per commit is a problem by month three.
Anything over 1MB, say why in `demo.md`.

## Step 6 — Register

```bash
node cui/bin/cui.mjs demo register --sha HEAD --dir demos/004-synthetic-orders
```

This indexes the artifacts so the CUI renders them inline on the commit page. Note the demo
directory is committed *with* the code — run `register` again after the commit lands (or just
let the `Demo:` trailer do it; `node cui/bin/cui.mjs ingest` resolves the directory from the trailer).

When skipping:

```bash
node cui/bin/cui.mjs demo skip --sha HEAD --reason "pure refactor; output byte-identical on fixture corpus"
```

## Anti-patterns

- A screenshot of passing tests. That's test output, not a demo.
- `console.log` from inside the feature, presented as external verification.
- Cherry-picked sample rows that hide the boring or broken ones. Show `ORDER BY random()`.
- A realism check with no failure mode.
- `demo.md` that describes what the code does instead of showing what happened.
- Omitting **Limits** because everything worked.
