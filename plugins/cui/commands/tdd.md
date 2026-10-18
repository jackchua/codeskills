---
description: Build one registered feature test-first - red, implement, green, full suite, ship
argument-hint: "[FR-… | next | fix <bug description>]"
---

Use the `feature-tdd` skill for: $ARGUMENTS

- An ID → that feature.
- `next` or empty → pick the next feature per the skill's Step 0 and tell me which and why
  before writing tests.
- `fix …` → find (or register) the feature the bug breaks; the red test reproduces the bug.

Registry:
!`node cui/bin/cui.mjs registry list 2>/dev/null || echo "(no registry — run /cui:features first)"`

Waiting on me:
!`node cui/bin/cui.mjs approvals 2>/dev/null | head -20`

Work through every step. Do not write implementation code before `cui tdd red` has passed,
and finish with `/cui:ship`.
