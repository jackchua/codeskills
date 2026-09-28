---
description: Test, cover, demo, score against milestones, and commit
argument-hint: "[optional note about what this change is]"
---

Use the `ship-commit` skill. It will invoke `commit-demo` for the demo decision.

Note from me: $ARGUMENTS

Working tree:
!`git status --short 2>/dev/null | head -40`

Change size:
!`git diff --stat HEAD 2>/dev/null | tail -5`

Milestones to score against:
!`node cui/bin/cui.mjs status --brief 2>/dev/null || cat .cui/product-functions.yaml 2>/dev/null | grep -E '^\s+(key|title|status):' || echo "(no milestones — run /cui:pf)"`

Work through every step of the skill in order. Do not skip coverage, and do not skip the
demo decision even if the answer is no.
