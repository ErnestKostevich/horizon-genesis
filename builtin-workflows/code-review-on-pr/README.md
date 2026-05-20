# Code Review on PR

Runs a 3-skill review pipeline (`code-review`, `security-scan`, `write-test`)
against a GitHub pull request diff and posts a combined markdown review back to
the PR. Falls back to clipboard if posting is unavailable.

## What it does

1. Fetches the PR diff via the `github` plugin
2. Fetches PR title + description for context
3. Runs the `code-review` skill on the diff
4. Runs the `security-scan` skill (secrets, dependency vulns)
5. Runs the `write-test` skill in `coverage_audit` mode to flag missing tests
6. Composes the three outputs into one markdown comment via `summarize-anything`
7. Posts the comment to the PR
8. Copies the comment to clipboard as a fallback
9. Fires a desktop notification

## Trigger

`manual` — invoke from the Workflows panel and supply the `pr_url` input, or run
from CLI:

```
horizon workflow run code-review-on-pr --input pr_url=https://github.com/owner/repo/pull/123
```

## Prerequisites

| Component | Type | Required? | Where to configure |
|---|---|---|---|
| `github` plugin | plugin | Yes | Settings → Plugins → GitHub → Personal Access Token (PR read/write scope) |
| `code-review` skill | skill | Yes | Built-in (`builtin-skills/code-review/`) |
| `security-scan` skill | skill | Yes | Built-in (`builtin-skills/security-scan/`) |
| `write-test` skill | skill | Yes | Built-in (`builtin-skills/write-test/`) |
| `summarize-anything` skill | skill | Yes | Ships with workspace skill pack |

The workflow ships **disabled**. Enable it from Settings → Workflows after
adding a GitHub token.

## Customization

- **Skip posting** — remove the `post_comment` step to keep the review local
  (the `clipboard_write` step will still copy it for manual paste).
- **Use GitLab / Bitbucket** — replace the `pluginId: github` references with
  the corresponding plugin (`gitlab`, `bitbucket`) — both expose equivalent
  `get_pr_diff` and `post_pr_comment` tools.
- **Add more skills** — drop in additional skill steps (e.g. `lint-runner`,
  `dependency-audit`) and add their outputs to the `compose_review` inputs list.

## Auto-trigger via webhook

To run on every PR open/sync automatically, deploy a small webhook receiver
(see `docs/webhook-receiver.md`) that calls
`horizon workflow run code-review-on-pr` with the incoming PR URL. Native
webhook trigger support is planned — track [issue #XXX].

## Security note

`security-scan` only inspects diff content. It will not detect issues already
present on the base branch. Run a full repo scan separately for that.
