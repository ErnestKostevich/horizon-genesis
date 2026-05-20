---
name: migrate-framework
description: |
  Codemod for common framework migrations: React class components to
  hooks, JavaScript to TypeScript, CommonJS to ESM, Vue 2 to Vue 3
  composition API. Activate when the user says "migrate to TS",
  "convert to ESM", "modernize this codebase", "upgrade React",
  "switch from require to import".
license: BUSL-1.1
metadata:
  category: code
  version: 1.0.0
  author: Horizon AI
---

# Framework migration codemod

Large migrations break in the same handful of ways. Do them mechanically,
one file at a time, with the test suite green between each file. Use
`run_shell` to run tests/typecheck, `read_file` and `Edit` for changes.

## Procedure

1. **Identify the migration.** Confirm source → target with the user:
   - JS → TS (with or without strict mode?)
   - CommonJS → ESM (`require`/`module.exports` → `import`/`export`)
   - React class → hooks
   - Vue 2 Options API → Vue 3 Composition API
   - Webpack → Vite
   - Moment.js → date-fns
   Refuse if the target is ambiguous — ask first.
2. **Pre-flight check.** Confirm: (a) tests exist and pass on the current
   codebase, (b) there is a clean git working tree. If either fails,
   stop and tell the user. The migration depends on the test suite to
   catch regressions.
3. **Inventory.** Use `grep` to count occurrences. Report scope:
   "Found 47 class components across 32 files." Let the user pick
   batch size — default to 5 files per commit.
4. **Migrate one file.** For each file:
   - Read it.
   - Apply the transformation (see per-migration rules below).
   - Run typecheck + tests.
   - If green, commit. If red, revert that file and report.
5. **Per-migration rules:**
   - **JS → TS**: rename `.js` → `.ts`/`.tsx`. Add explicit types only
     where TS can't infer. Use `unknown` not `any`. Add `// @ts-expect-error`
     with a TODO comment for the few cases that need follow-up.
   - **CJS → ESM**: `const x = require("y")` → `import x from "y"`,
     `module.exports = X` → `export default X`. Add `.js` extensions
     to relative imports if `package.json` has `"type": "module"`.
   - **React class → hooks**: see the dedicated `refactor-react` skill.
   - **Vue 2 → 3**: `data()` → `ref`/`reactive`, lifecycle hooks
     prefix `on` (`mounted` → `onMounted`), `this.$emit` → `emit()`.
6. **Final pass.** Run the full test suite. Run the linter. Report
   what changed in plain English: "Migrated 47 files. 3 files needed
   manual fixes (listed below). Test suite green."

## Anti-patterns to avoid

- Don't migrate and refactor in the same pass.
- Don't auto-fix lint issues introduced by the migration in the same
  commit — separate commits per intent.
- Don't suppress errors with `any` / `@ts-ignore` without a TODO.

## Example invocation

> User: "Migrate this project from CommonJS to ESM"

Response: confirm git tree is clean, count `require()` usages with
grep, ask user about batch size, convert files in batches of 5,
run tests between each batch, summarize at the end.
