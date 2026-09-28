---
name: pf-milestones
description: Define, vet and amend Product Function (PF) milestones before any code is written. Use at the start of a new project, when the user says "let's build X", asks to scaffold or plan a project, runs /pf, or when a write is blocked because .cui/product-functions.yaml is missing or empty. Also use when adding, splitting, re-scoping or closing a milestone mid-project.
---

# Product Function milestones

A Product Function (PF) is a **capability the user can observe working**, not a task,
not a layer, not a refactor. PF milestones are the contract for the whole project:
every later commit is scored against them in the CUI. Getting them wrong is expensive,
so this skill is an interview, not a form-fill.

**No implementation code is written until `.cui/product-functions.yaml` exists and the
user has explicitly approved it.** The plugin's PreToolUse hook enforces this; do not
work around the hook by writing code into allowed paths.

## When this runs

| Situation | What to do |
| --- | --- |
| Brand new project | Full interview below, write the file, get approval |
| A write was blocked by the gate | Say why, then run the full interview |
| User wants to add/change one milestone | Skip to [Amending](#amending) |
| User asks "where are we?" | Don't interview — read the file and run `node cui/bin/cui.mjs status` |

## Step 1 — Understand the product before proposing milestones

Ask the user, in one message, the smallest set of questions you cannot answer yourself:

1. **Who is this for and what do they do today instead?**
2. **What is the north-star outcome?** One sentence. If they can't say it, the project
   is not ready for milestones and you should say so.
3. **What is explicitly out of scope for v1?**
4. **What does "done" look like to you — what would you click through to believe it?**
5. **Any fixed constraints?** Stack, deadline, data sources, compliance, existing systems.

If the user already gave you a rich brief, don't re-ask — reflect back what you extracted
and ask only about gaps. Never ask more than five questions at once.

## Step 2 — Draft the milestones

Draft **3 to 7** milestones. More than seven means you are describing tasks; fewer than
three usually means one of them is really three.

Each milestone must pass all of these tests. Discard or rewrite any that fail:

- **Observable.** A non-technical person can watch it happen and agree it works.
  - Good: "A user can upload a CSV and see it charted."
  - Bad: "Set up the database layer." "Add logging." "Refactor the API."
- **Independently valuable.** If the project stopped right after this milestone, something
  real would have been gained.
- **Vertically sliced.** It cuts through every layer it needs. It is not "the backend for X".
- **Demonstrable.** You can name, right now, the artifact that proves it — a screenshot, a
  table of rows, a recorded terminal session, an HTTP transcript. Write that down; the
  `commit-demo` skill will hold you to it.
- **Falsifiable acceptance criteria.** 2–5 per milestone, each checkable by a human or a
  test, each phrased so the answer is yes/no. No "works well", no "is performant" without
  a number.

Order them by dependency and by how early they de-risk the product. Put the milestone that
would kill the project if it failed as early as its dependencies allow.

## Step 3 — Vet with the user

Present the draft as a table (key, title, the one-line demo that would prove it). Then ask
directly:

> Which of these is wrong, missing, or secretly two milestones?

Iterate until the user approves. **Do not write the file on the first draft** unless the
user explicitly approves it. Vetting is the point of this skill; a rubber-stamped list is
worth nothing.

Push back once, concretely, if you see:
- a milestone that is really infrastructure wearing a product costume
- a milestone with no believable demo
- acceptance criteria that can't fail
- a v1 that is obviously six months of work

State the concern in a sentence or two. If the user reaffirms, record it and move on.

## Step 4 — Write the file

Write `.cui/product-functions.yaml`. Schema:

```yaml
version: 1
product: "Short product name"
north_star: "One sentence the whole project serves."
out_of_scope:
  - "Things deliberately not in v1"
milestones:
  - key: PF-1                      # stable, never renumbered once written
    title: "A user can upload a CSV and see it charted"
    why: "This is the whole value proposition in one interaction."
    demo: "Screen capture: upload sample.csv, chart renders with correct axis labels."
    depends_on: []                 # list of other keys
    status: not_started            # not_started | in_progress | done
    acceptance:
      - id: PF-1.1
        text: "A 10k-row CSV uploads in under 5s and persists to storage"
        status: open                # open | met
      - id: PF-1.2
        text: "Column types are inferred and shown before charting"
        status: open
```

Rules:
- Keys are **permanent**. Never renumber. A dropped milestone becomes `status: dropped`,
  it does not free its number.
- `demo` is required on every milestone. If you cannot write it, the milestone is not ready.
- Keep the file hand-editable. It is the source of truth; the CUI database is a projection.

Then run:

```bash
node cui/bin/cui.mjs sync          # loads the YAML into the CUI database
node cui/bin/cui.mjs status        # prints current milestone progress
```

## Step 5 — Hand off

Tell the user, in three lines:
- the milestone list is written and synced
- the next step is `/blueprint` (repo structure must be locked before code)
- `npm run cui` (or `npm --prefix cui start`) opens the CUI if they want to see it

Do not start implementing. `/blueprint` is next.

## Amending

Mid-project changes go through the same vetting, scoped to the change:

- **Add** a milestone → next free key, never reusing a retired one.
- **Split** PF-3 into two → PF-3 keeps the part it still describes; the remainder becomes a
  new key. Note the split in the new milestone's `why`.
- **Drop** → `status: dropped` plus a `dropped_reason`. Never delete the entry; commits in
  the CUI still reference it.
- **Close** → set `status: done` only when every acceptance criterion is `met` **and** a
  commit in the CUI carries a passing demo for it. Otherwise it is still `in_progress`.

After any amendment run `node cui/bin/cui.mjs sync`, and tell the user which commits are now affected
(`node cui/bin/cui.mjs status --milestone PF-3`).

## Anti-patterns

- Writing the file without the user answering Step 3. The vetting *is* the deliverable.
- Milestones that mirror your implementation plan (`PF-1: schema`, `PF-2: API`, `PF-3: UI`).
  That is a task list. Re-slice it vertically.
- Acceptance criteria copied from the title.
- Starting to code "just the scaffolding" while the interview is open.
