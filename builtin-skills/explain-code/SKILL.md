---
name: explain-code
description: "Explain a file, function, stack trace, or system flow in plain language without changing code."
version: "0.1.0"
author: "Horizon Team"
tags: [explain, code, architecture, learning]
aliases: [explain, walkthrough, understand-code]
triggers: [explain this code, how does this work, walk me through, what does this error mean]
examples: [explain this function, describe the data flow, explain this stack trace]
permissions: ["filesystem.read"]
---
# Explain code

Use this skill when the user wants understanding before edits.

## Procedure

1. Start with the purpose of the code.
2. Explain the control flow in the order it runs.
3. Name important state and side effects.
4. Call out surprising behavior or risks.
5. End with what to inspect next if the user wants to change it.
