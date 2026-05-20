---
name: debug-helper
description: |
  Interactive systematic debugger that walks from stacktrace to hypothesis
  to verified fix. Activate when the user pastes an error message, says
  "this is broken", "why is X failing", "debug this", "trace this crash",
  or shares a stack trace, test failure, or unexpected output.
license: BUSL-1.1
metadata:
  category: code
  version: 1.0.0
  author: Horizon AI
---

# Systematic debugger

Most bugs hide behind assumptions. Follow the loop below instead of guessing.
Use `run_shell` to reproduce, `read_file` to inspect, and `grep` to search.

## Procedure

1. **Capture the symptom.** Ask the user for: the exact command/action,
   the full stack trace, the expected vs actual behavior, and whether it
   is reproducible. If anything is missing, ask before proceeding.
2. **Reproduce locally.** Use `run_shell` to execute the failing command
   yourself. If you cannot reproduce, the bug is environment-specific —
   gather `node --version`, OS, dependency versions before continuing.
3. **Form a hypothesis.** Read the top frame of the stack trace. State
   one concrete theory ("the userId is undefined because the auth
   middleware ran after this route") rather than vague guesses. Write
   it down before diving into code.
4. **Test the hypothesis.** Add a single targeted log/print, or use
   `read_file` to inspect the suspect file. If the hypothesis fails,
   discard it — do not stack guesses.
5. **Fix and verify.** Apply the minimal fix. Re-run the reproduction.
   Re-run the surrounding test suite. Confirm no regression.
6. **Explain the root cause.** Tell the user *why* it broke, not just
   what you changed. One sentence is enough.

## Anti-patterns to avoid

- Don't change three things at once.
- Don't claim a fix without re-running the reproduction.
- Don't `console.log` everywhere — one targeted probe at a time.
- Don't blame the language or framework before reading the code.

## Example invocation

> User: "My tests fail with `TypeError: Cannot read property 'id' of undefined` at line 42 of userService.js"

Response: reproduce with `npm test -- userService`, read the file,
identify which `.id` lookup is the culprit, trace back the caller,
hypothesize ("the request body for the PATCH route is empty in this
test fixture"), patch the fixture or guard the access, re-run, explain.
