---
description: Define or amend Product Function milestones (required before any code)
argument-hint: "[add|amend|status|<free-form description of the product>]"
---

Use the `pf-milestones` skill.

Argument: $ARGUMENTS

- No argument, or a product description → run the full interview and draft milestones.
- `add` / `amend` → jump to the Amending section of the skill.
- `status` → don't interview; run `node cui/bin/cui.mjs status` and summarise progress against milestones.

Current state:
!`cat .cui/product-functions.yaml 2>/dev/null || echo "(no .cui/product-functions.yaml yet — this is a fresh project)"`
