---
description: Lock the repo structure, entry points and command catalogue (required before any code)
argument-hint: "[amend <what you need to add>]"
---

Use the `repo-blueprint` skill.

Argument: $ARGUMENTS

If the argument starts with `amend`, go to the "Amending a locked blueprint" section.
Otherwise run the full flow: derive structure from the milestones, propose it, get approval,
write `.cui/blueprint.yaml` and `.cui/commands.yaml`, create the directories, generate
`ARCHITECTURE.md`, then `node cui/bin/cui.mjs sync`.

Milestones this structure must serve:
!`cat .cui/product-functions.yaml 2>/dev/null || echo "(MISSING — run /cui:pf first, structure follows from milestones)"`

Existing blueprint:
!`cat .cui/blueprint.yaml 2>/dev/null || echo "(none yet)"`
