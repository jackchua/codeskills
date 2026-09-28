---
name: repo-blueprint
description: Lock the repository structure, entry points and CLI command catalogue before any code is written. Use after PF milestones are approved, when the user runs /cui:blueprint, when a write is blocked because .cui/blueprint.yaml is missing or unlocked, or when a change genuinely needs a new top-level directory, entry point or runnable command.
---

# Repo blueprint

The blueprint is the answer to "where does this code go?" decided **once, in advance**, so
that six weeks of AI-written commits don't silently invent four different places for the
same concern. It also catalogues every entry point and every runnable command, which the
CUI indexes and makes searchable.

**No implementation code is written until `.cui/blueprint.yaml` exists with `locked: true`
and the user has approved it.** The PreToolUse hook enforces this.

Prerequisite: `.cui/product-functions.yaml` exists and is approved. If not, run
`pf-milestones` first — structure follows from what you're building.

## Step 1 — Derive structure from the milestones, not from habit

Read `.cui/product-functions.yaml`. For each milestone ask: *what does this milestone need
to exist that nothing else provides?* That is your directory list. A directory that serves
no milestone is speculation — leave it out. You can always amend.

Pick the smallest structure that serves the milestones. Three directories that each have a
crisp job beat twelve organised by pattern name.

## Step 2 — Propose the blueprint

Present to the user, before writing anything:

1. **The tree** — top-level and one level deep, no deeper. Annotate each with its one-line job.
2. **The boundary rules** — for each directory, what it owns and what it must never do.
   These are the rules that keep the codebase legible. Be specific and enforceable:
   - Good: `src/api` — "HTTP shape only: parse, validate, call a service, serialise. Never
     touches the DB client directly."
   - Bad: `src/api` — "API stuff."
3. **Entry points** — every way a human or machine starts this system.
4. **The command catalogue** — everything runnable from a terminal.
5. **Naming conventions** — file casing, test file location and suffix, module boundaries.

Ask the user to approve or correct it. Push back if they ask for a structure that has no
home for something a milestone clearly needs.

## Step 3 — Write `.cui/blueprint.yaml`

```yaml
version: 1
locked: true
locked_at: "2026-09-28"
stack:
  language: typescript
  runtime: "node 26"
  package_manager: npm
  test_runner: "node:test"
conventions:
  files: kebab-case
  tests: "colocated, *.test.ts"
  exports: "named only, no default exports"
  imports: "absolute from src/, no ../.. traversal"
layout:
  - path: src/api
    purpose: "HTTP shape only: parse, validate, delegate, serialise."
    owns: ["route definitions", "request/response schemas"]
    forbidden: ["direct database access", "business rules"]
    serves: [PF-1, PF-2]
  - path: src/domain
    purpose: "Business rules. Pure functions where possible, no I/O."
    owns: ["entities", "invariants", "pricing rules"]
    forbidden: ["http types", "sql", "env var reads"]
    serves: [PF-1, PF-3]
  - path: src/data
    purpose: "The only place that talks to Postgres."
    owns: ["queries", "migrations", "connection pool"]
    forbidden: ["business rules"]
    serves: [PF-1, PF-2, PF-3]
entrypoints:
  - id: api
    kind: http                 # http | cli | worker | job | ui
    command: "npm run dev:api"
    path: src/api/index.ts
    port: 3000
    description: "Main JSON API. Reads DATABASE_URL, PORT."
    serves: [PF-1, PF-2]
  - id: seed
    kind: cli
    command: "npm run db:seed"
    path: scripts/seed.ts
    description: "Generates synthetic customers and orders."
    serves: [PF-2]
```

Every entry in `layout` needs a real `forbidden` list. An empty one means you haven't
decided the boundary yet.

## Step 4 — Write `.cui/commands.yaml`

This is the catalogue the CUI's command palette searches. Anything a human might type in a
terminal belongs here, including commands that don't exist yet but will.

```yaml
version: 1
commands:
  - name: "db:seed"
    command: "npm run db:seed"
    category: database          # database | dev | test | build | deploy | diagnostics
    description: "Populate Postgres with synthetic customers and orders."
    entrypoint: scripts/seed.ts
    safe: true                  # false = mutates production-like state, needs confirmation
    args:
      - flag: "--rows <n>"
        description: "Rows per table. Default 1000."
      - flag: "--truncate"
        description: "Empty tables first."
    example: "npm run db:seed -- --rows 50000 --truncate"
    outputs: "Prints per-table row counts."
```

Rules:
- `safe: false` for anything destructive, anything that writes outside the repo, or anything
  that costs money. The CUI badges these red and requires a click-through.
- Keep `command` copy-pasteable verbatim.
- Every `entrypoints[].command` from the blueprint must also appear here.

## Step 5 — Create the structure and the architecture doc

1. Create the directories with a `.gitkeep` (or a real index file if one is obvious).
2. Generate `ARCHITECTURE.md` at the repo root from the blueprint — the human-readable
   version, with the tree, the boundary rules table, and the entry point list. Head it with
   a line saying it is generated from `.cui/blueprint.yaml` and should not be hand-edited.
3. Run:

```bash
node cui/bin/cui.mjs sync      # indexes layout, entrypoints and commands into the CUI
node cui/bin/cui.mjs doctor    # verifies every entrypoint path exists and every command resolves
```

`node cui/bin/cui.mjs doctor` will fail on paths that don't exist yet — that is expected before implementation
and it reports them as `planned` rather than `broken`.

## Step 6 — Hand off

Tell the user: structure is locked, `ARCHITECTURE.md` is generated, commands are searchable
in the CUI, and implementation can now begin against PF-1.

## Amending a locked blueprint

Structural drift is the failure mode this whole file exists to prevent, so amendments are
deliberate:

1. **Try to fit the existing structure first.** Most "I need a new directory" moments are
   really "I haven't read `ARCHITECTURE.md`". Say which existing directory you considered
   and why it doesn't fit.
2. If it genuinely doesn't fit, tell the user: what you want to add, which milestone forces
   it, and what rule it will carry. Get an explicit yes.
3. Update `.cui/blueprint.yaml`, bump nothing — the file is not versioned per-change, git is.
4. Regenerate `ARCHITECTURE.md`, run `node cui/bin/cui.mjs sync`.
5. Note the amendment in the commit body as `Blueprint: added src/x (PF-4 requires ...)`.
   The CUI surfaces these so structural changes are auditable.

Never add a directory silently. Never leave a new runnable command out of `commands.yaml` —
an undiscoverable command is how a codebase becomes opaque.
