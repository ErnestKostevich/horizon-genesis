---
name: bug-report
description: "Turn screenshots, logs, console errors, or user complaints into a precise bug report with reproduction steps."
version: "0.1.0"
author: "Horizon Team"
tags: [bug, report, logs, screenshot, reproduction]
aliases: [triage-bug, repro, issue-report]
triggers: [make bug report, why is this broken, console error, reproduce this bug, file an issue]
examples: [turn this screenshot into a bug report, summarize the console error and steps to reproduce]
permissions: ["filesystem.read"]
---
# Bug report

Use this skill when the user shows a broken UI, console error, failed request, or confusing behavior.

## Procedure

1. Extract the observable symptom.
2. Identify likely scope: renderer UI, main process, API/provider, persistence, or external service.
3. Write reproduction steps that another developer can follow.
4. Include expected behavior, actual behavior, evidence, and suspected files.
5. Add a compact fix hypothesis only when supported by the evidence.
