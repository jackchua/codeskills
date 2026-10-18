---
description: Scaffold the CUI into this project (app, .cui/, CI workflows, git hook)
argument-hint: "[--force] [--no-install] [target dir]"
---

Scaffold the CUI into the current project, then hand off to `/cui:pf`.

Arguments: $ARGUMENTS

Current directory and state:
!`pwd; ls -a | head -30; test -d cui && echo "(cui/ ALREADY EXISTS)"; test -d .cui && echo "(.cui/ ALREADY EXISTS)"; git rev-parse --is-inside-work-tree 2>/dev/null || echo "(not a git repository)"`

## Steps

1. **Check before writing.** If `cui/` already exists and `--force` is not in the arguments,
   stop and ask whether to overwrite it. `--force` replaces the CUI app and the CI files but
   never touches `.cui/*.yaml`. If this is not a git repository, say the scaffolder will run
   `git init` and continue unless I object.

2. **Run the scaffolder** that ships with the installed plugin, so the scaffolded files match
   the skills you are running. Fall back to GitHub only if the local copy can't be found:

   ```bash
   S=$(node -e "try{const m=require(require('os').homedir()+'/.claude/plugins/known_marketplaces.json');process.stdout.write((m.codeskills?.installLocation||'')+'/scripts/scaffold.mjs')}catch{}")
   [ -f "$S" ] || S="$HOME/.claude/plugins/marketplaces/codeskills/scripts/scaffold.mjs"
   if [ -f "$S" ]; then node "$S" --yes $ARGUMENTS
   else npx -y github:jackchua/codeskills --yes $ARGUMENTS
   fi
   ```

   It installs and builds the dashboard, which takes a minute or so. Report any line it
   prints starting with `!`, and do not retry a failed step blindly.

3. **Report** in a few lines: what was written (`cui/`, `.cui/`, `CUI.md`,
   `.github/workflows/cui.yml` and `cui-nightly.yml`, `.github/CODEOWNERS`, the post-commit
   hook), and the two things only I can do later:
   - replace `@OWNER` in `.github/CODEOWNERS` with my GitHub handle
   - once the repo is on GitHub, make the `cui` workflow a required check and turn on
     "Require review from Code Owners"

4. **Hand off.** Implementation is now gated until milestones exist and the blueprint is
   locked. Offer to start `/cui:pf` now. Don't start it without my yes.
