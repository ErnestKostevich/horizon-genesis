---
name: code-review
description: "Review a code change for bugs, regressions, security issues, missing tests, and maintainability risks."
version: "0.1.0"
author: "Horizon Team"
tags: [code, review, diff, pr, security, tests]
aliases: [review, pr-review, audit-code]
triggers: [review this diff, check my changes, find bugs, pull request review, code audit]
examples: [review the current git diff, inspect this pull request, find risky changes before commit]
permissions: ["filesystem.read"]
---
# Code review

Use this skill when the user asks for a review, audit, or pre-merge check.

## Procedure

1. Identify the changed files and the user's intended behavior.
2. Read the diff before reading full files.
3. Prioritize findings by severity:
   - correctness bugs
   - security/privacy risks
   - data loss or destructive behavior
   - missing tests for risky behavior
   - maintainability issues only when they can cause real future bugs
4. Cite file paths and exact line references when possible.
5. Keep the review actionable. If there are no blocking issues, say that clearly.

## Output

Start with findings. Then list open questions and test gaps. Keep summaries short.
