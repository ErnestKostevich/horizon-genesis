---
name: pr-description
description: "Write a clear pull request description from code changes, commits, or a user-provided summary."
version: "0.1.0"
author: "Horizon Team"
tags: [github, pr, changelog, summary, diff]
aliases: [pr-body, pull-request, changelog]
triggers: [write pr description, summarize this branch, make pull request body, generate changelog]
examples: [create a PR description for my changes, summarize commits into a pull request]
permissions: ["filesystem.read"]
---
# Pull request description

Use this skill when the user needs a PR body or changelog.

## Procedure

1. Determine the base branch and changed files if available.
2. Group changes by user-visible behavior, not by file name.
3. Mention tests run and tests not run.
4. Avoid claiming deploys, screenshots, or tests that were not actually performed.

## Template

```
## Summary
- ...

## Tests
- ...
```
