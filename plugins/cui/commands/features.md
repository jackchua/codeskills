---
description: Build or amend the feature registry - IDs and test plans for every feature (required before implementing)
argument-hint: "[add <what>|retire FR-…|except FR-…|check]"
---

Use the `feature-registry` skill.

Argument: $ARGUMENTS

- No argument → derive features from the milestones' acceptance criteria, vet with me, write
  `.cui/features.yaml`, wire the test runner if it isn't.
- `add …` → register the new feature(s) with test plans (allowed without approval).
- `retire FR-…` / anything that drops an obligation → write a proposal and tell me it's waiting.
- `except FR-…` → try once more to test it; if it truly can't be, add a `proposed` exception.
- `check` → run `node cui/bin/cui.mjs registry check` and explain any failures.

Milestones:
!`cat .cui/product-functions.yaml 2>/dev/null || echo "(MISSING — run /cui:pf first)"`

Current registry:
!`node cui/bin/cui.mjs registry list 2>/dev/null || echo "(no registry yet)"`

Test runner config:
!`grep -E '^(test_command|feature_test_command|test_results|  - )' .cui/config.yaml 2>/dev/null || echo "(no .cui/config.yaml)"`
