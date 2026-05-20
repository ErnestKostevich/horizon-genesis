---
name: git-workflow
description: |
  Safe branch, rebase, cherry-pick, and merge operations with built-in
  guardrails against force-push, history rewrites on shared branches,
  and accidental data loss. Activate when the user says "rebase",
  "cherry-pick", "merge", "create branch", "squash commits", "fix history",
  "i messed up git", or is about to run a destructive git operation.
license: BUSL-1.1
metadata:
  category: code
  version: 1.0.0
  author: Horizon AI
---

# Safe git workflow

Git is unforgiving. Most "lost work" comes from `--force`, `--hard`,
or rebasing a shared branch. This skill executes git operations with
a checklist before each destructive step. Use `run_shell` for all git
commands.

## Procedure

1. **Identify the intent.** Ask "what are you trying to end up with?"
   before running any command. Branch names, commit count, and current
   HEAD matter.
2. **Snapshot before destructive ops.** Before any `rebase`, `reset --hard`,
   or `cherry-pick`, run `git branch backup/<timestamp>` so the original
   tip is recoverable. Tell the user the backup branch name.
3. **Check upstream state.** Run `git status -sb` and `git fetch`. Never
   rewrite history on a branch that already pushed to a shared remote
   (`main`, `develop`, `release/*`). If the user insists, require an
   explicit "yes, force-push to <branch>" confirmation.
4. **Operation-specific guardrails:**
   - **rebase**: prefer `git rebase --interactive` only on private
     branches. After rebase, push with `--force-with-lease`, never `--force`.
   - **cherry-pick**: include `-x` to record the source commit hash.
     If conflicts arise, stop and show the user the conflict before
     resolving.
   - **squash/fixup**: confirm the squash range. Squashing already-pushed
     commits requires `--force-with-lease`.
   - **merge**: prefer `--no-ff` for feature branches into main so the
     PR boundary is visible in history.
   - **reset**: default to `--mixed`. Require explicit user confirmation
     for `--hard`. Suggest `git stash` first if there are uncommitted
     changes.
5. **Verify.** After the operation, run `git log --oneline -10` and
   show the user the new history. Confirm the working tree is clean.
6. **Recovery hatch.** Always mention `git reflog` as the escape route
   if anything looks wrong. The backup branch from step 2 is the
   second escape route.

## Anti-patterns to avoid

- Don't run `git push --force` — always `--force-with-lease`.
- Don't `git reset --hard` without snapshotting.
- Don't rebase `main`. Ever.
- Don't run interactive commands (`rebase -i`) without explicit user buy-in.

## Example invocation

> User: "I have three messy WIP commits, squash them and rebase onto main"

Response: backup current branch, fetch, interactive rebase with squash
plan shown to user first, force-with-lease push, confirm log, mention
backup branch name and reflog as recovery options.
