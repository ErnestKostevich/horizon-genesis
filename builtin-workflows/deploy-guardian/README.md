# Deploy Guardian

Polls configured HTTP endpoints every 5 minutes. On failure, fetches recent
logs, runs the `log-analyzer` skill for diagnosis, and posts an alert to your
ops channel.

## What it does

1. `server-health` skill pings every endpoint in `settings.healthEndpoints`
2. Node guard exits early (exit code 2 → step is "done", workflow continues
   without alerting) when all endpoints return expected status codes
3. On any failure, tails recent logs via the `logs` plugin
4. `log-analyzer` skill correlates failing endpoints with log entries to produce
   a likely-cause diagnosis
5. Posts a markdown alert with failing endpoints + diagnosis to your channel
6. Appends a JSONL line to `memory/ops/deploy-guardian-history.jsonl` for trend
   analysis
7. Fires a desktop notification

When all endpoints are healthy, steps 3–7 are skipped (the run completes
quickly and silently).

## Trigger

`interval:5` — runs every 5 minutes after the engine starts. Adjust to
`interval:1` for noisier monitoring or `interval:15` for lower noise.

## Prerequisites

| Component | Type | Required? | Where to configure |
|---|---|---|---|
| `server-health` skill | skill | Yes | Ships with workspace skill pack |
| `log-analyzer` skill | skill | Yes | Ships with workspace skill pack |
| `logs` plugin | plugin | Yes | Settings → Plugins → Logs → source (file path, journalctl, Render, Fly, etc.) |
| `memory` plugin | plugin | Built-in | No setup needed |
| `telegram` plugin | plugin | Yes (for alerts) | Settings → Plugins → Telegram |

Required settings (set on the workflow's settings page):

- `settings.healthEndpoints` — array of `{ url, name }` objects, e.g.
  `[{"name":"api","url":"https://api.example.com/health"}]`
- `settings.logSource` — identifier for the `logs` plugin source
- `settings.alertChatId` — Telegram chat or channel ID for alerts

The workflow ships **disabled**. Enable from Settings → Workflows after
configuring endpoints and the alerts channel.

## Customization

- **Different alert channel** — swap `telegram` for `slack`, `discord`,
  `pagerduty`, or `email`. Each exposes an equivalent `send_message` tool.
- **Multi-region health** — split endpoints into multiple workflows
  (`deploy-guardian-us`, `deploy-guardian-eu`) each with their own polling
  interval.
- **Suppress repeat alerts** — wrap step 5 in a deduplication guard by reading
  the most recent history line and skipping if the same failure was alerted in
  the last N runs (handled in a follow-up issue).

## Why is the guard a `run_code` step?

The engine's step model does not yet support conditional branches natively.
Step 1 (`branch_on_health`) returns exit code `2` when everything is healthy.
Because no subsequent step has `stopOnError: true`, the workflow continues but
the placeholder `{{steps.branch_on_health.output.failures}}` resolves to empty
content — downstream steps silently no-op. When native conditional support
lands, switch to a proper `if` step.

## History format

`memory/ops/deploy-guardian-history.jsonl` — one JSON object per failure event:

```json
{"ts":"2026-05-20T18:35:00.000Z","ok":false,"failures":[{"name":"api","status":503}],"diagnosis":"..."}
```

Use this for SLO calculations or weekly ops reports.
