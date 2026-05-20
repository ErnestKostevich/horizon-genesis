---
name: commit-message
description: |
  Generate Conventional Commits messages from the staged diff. Activate
  when the user says "write a commit message", "what should I name this
  commit", "stage and commit", "generate commit", or runs `git commit`
  without `-m`. Produces type(scope): subject + body + footer.
license: BUSL-1.1
metadata:
  category: code
  version: 1.0.0
  author: Horizon AI
---

# Conventional Commits generator

Output exactly one commit message in Conventional Commits format. The
message is the contract — it powers changelogs, release-please, and
semantic versioning. Use `run_shell` for git, `read_file` for context.

## Procedure

1. **Inspect the staged diff.** Run `git diff --cached --stat` for the
   file list, then `git diff --cached` for the content. If nothing is
   staged, stop and ask the user to stage their changes first.
2. **Pick a type.** Use the smallest accurate type:
   - `feat` — user-facing new capability
   - `fix` — bug fix
   - `refactor` — code change with no user-visible behavior change
   - `perf` — measurable performance improvement
   - `docs` — README / comments / changelog only
   - `test` — test-only changes
   - `chore` — tooling, deps, build, CI
   - `style` — formatting only (rare; usually folds into refactor)
   - `revert` — reverts a previous commit
3. **Pick a scope.** Use the directory or package most affected
   (`auth`, `api`, `ui`, `db`). Lowercase. Omit if the change spans
   the whole repo.
4. **Write the subject.** Imperative mood, lowercase first letter,
   no trailing period, ≤72 chars. "add retry logic to fetch helper"
   not "Added retry logic." or "adds retry logic."
5. **Body (optional).** Wrap at 72 chars. Explain *why*, not what —
   the diff already shows what. Include before/after numbers for `perf`.
6. **Footer (optional).** `BREAKING CHANGE: ...` for any incompatible
   change. `Closes #123` / `Refs #456` for issue links.
7. **Output the message** in a fenced block. Do not run `git commit`
   yourself unless the user explicitly asks.

## Anti-patterns to avoid

- Don't use vague subjects like "update code" or "fix bug".
- Don't include AI co-author trailers unless the user asks.
- Don't combine unrelated changes — suggest splitting into separate commits.

## Example invocation

> User: "commit my changes"

Response (after inspecting diff):

```
feat(auth): add refresh-token rotation on login

Previously a stolen refresh token remained valid for its full TTL.
Now each /login response rotates the refresh token and invalidates
the previous one server-side.

Closes #482
```
