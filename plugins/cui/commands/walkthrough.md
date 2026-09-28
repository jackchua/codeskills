---
description: Generate a Medium-style walkthrough of a commit
argument-hint: "[sha, defaults to HEAD]"
---

Use the `code-walkthrough` skill in walkthrough mode for commit `$ARGUMENTS` (default `HEAD`).

!`git show --stat ${ARGUMENTS:-HEAD} 2>/dev/null | head -40`

Write the walkthrough to `.cui/walkthroughs/<short-sha>.md`, then run
`node cui/bin/cui.mjs walkthrough register --sha <sha> --file .cui/walkthroughs/<short-sha>.md`
so it appears in the CUI. Tell me the CUI URL when done.
