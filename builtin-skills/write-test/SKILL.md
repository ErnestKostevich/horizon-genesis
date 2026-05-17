---
name: write-test
description: "Scaffold a unit test for an existing JavaScript or TypeScript function or module, picking the right runner (vitest / jest) based on the project's package.json."
version: "0.1.0"
author: "Horizon Team"
tags: [test, testing, vitest, jest, unit, javascript, typescript]
permissions: ["filesystem.read"]
helpers: ["helpers/detect-runner.js"]
---
# Writing a unit test for an existing module

When the user asks to "write a test for X" or "add tests for this file",
follow this procedure.

## 1. Detect the test runner

Run the bundled helper to inspect the project's `package.json`:

```
skill_run_helper { skill: "write-test", helper: "helpers/detect-runner.js", args: { root: "<workspace root>" } }
```

It returns `{ runner: "vitest" | "jest" | "none", configFile, testDir }`.

If `runner === "none"`, stop and ask the user which runner to install
before proceeding — do not silently pick one.

## 2. Locate the target

- Read the file the user named.
- Identify the public surface: exported functions, classes, default export.
- For each export, list the inputs (with types if TS) and the observable outputs / side effects.

## 3. Decide test placement

| Convention                          | Place tests here                          |
| ----------------------------------- | ----------------------------------------- |
| sibling `*.test.ts`                 | next to source file (default for vitest)  |
| `__tests__/` folder                 | sibling folder (default for jest CRA)     |
| top-level `test/` mirror            | mirrors `src/` tree (some monorepos)      |

Follow the dominant convention in the repo. If unclear, ask.

## 4. Write the test

- One `describe` per exported symbol.
- One `it` per behaviour, not per input. ("returns null when the user is logged out", not "calls fn with null user").
- Use `beforeEach` only for genuinely shared setup. Inline state otherwise.
- Mock external IO (`fs`, network) — never hit real services from a unit test.
- For pure functions: at least one happy path, one boundary case, one error case.
- For async functions: assert resolved value AND the rejection branch.
- For functions with side effects: assert both the return value AND the side effect (with a spy or mock).

## 5. Run the test

After writing, suggest the user run:

- vitest: `npx vitest run path/to/file.test.ts`
- jest: `npx jest path/to/file.test.ts`

Do NOT run it yourself unless the user explicitly asks. Their machine, their tradeoffs.

## 6. Final checklist

- [ ] No `it.skip` / `it.only` left behind.
- [ ] No real network or filesystem in unit tests.
- [ ] Test file imports the runner's globals correctly (vitest needs `import { describe, it, expect } from 'vitest'` unless `globals: true` in config).
- [ ] Type-checks (if TS).
