---
description: Report project health, or start the Central UI
argument-hint: "[start|status|doctor|sync|approvals]"
---

Argument: $ARGUMENTS (default: `status`)

- `start` → run `npm --prefix cui install && npm --prefix cui run build` if `cui/dist` is
  missing, then start the CUI in the background with `node cui/bin/cui.mjs serve` and give me
  the URL.
- `status` → run `node cui/bin/cui.mjs status` and summarise: milestone progress, feature
  registry health, anything waiting on my approval, coverage trend, commits missing demos or
  walkthroughs.
- `doctor` → run `node cui/bin/cui.mjs doctor` and fix anything it reports that you can fix safely.
- `sync` → run `node cui/bin/cui.mjs sync` to re-read the YAML files into the database.
- `approvals` → run `node cui/bin/cui.mjs approvals` and summarise each pending item and its
  case. Do not approve anything yourself; tell me the command or point me to the Approvals page.

!`node cui/bin/cui.mjs status 2>/dev/null || echo "(CUI not initialised here — scaffold it, see the cui template README)"`
