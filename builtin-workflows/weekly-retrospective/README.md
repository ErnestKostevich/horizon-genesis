# Weekly Retrospective

Every Friday at 18:00, aggregates the week's git commits, completed Linear/Jira
tickets, and journal entries into a digest, then runs a GTD-style
`weekly-review` skill to prompt reflection. Saves the result to workspace
memory and delivers it to your channel.

## What it does

1. Day-of-week guard — exits early on non-Fridays
2. Pulls last 7 days of commits across configured repos (`git` plugin)
3. Pulls last 7 days of completed tickets (`linear` plugin)
4. Pulls weekly journal entries from `memory` plugin
5. Runs `summarize-anything` to build a weekly digest
6. Runs `weekly-review` skill in GTD mode (next-action prompts, blockers)
7. Saves the reflection to `memory/retros/<iso-date>-weekly.md`
8. Delivers to Telegram (or your preferred channel)
9. Desktop notification

## Trigger

`schedule:18:00` daily, with a Node guard in step 0 that exits cleanly on any
day that isn't Friday (`getDay() === 5`).

**Why a guard instead of cron?** The current `workflowEngine.js` accepts
`cron:MM HH` (minute + hour) only — no day-of-week field. The guard is the
portable workaround. When the engine grows full 5-field cron support, replace
the trigger with `cron:0 18 * * 5` and delete step 0.

## Prerequisites

| Component | Type | Required? | Where to configure |
|---|---|---|---|
| `git` plugin | plugin | Yes | Settings → Plugins → Git → `trackedRepos` array |
| `linear` plugin | plugin | Optional | Settings → Plugins → Linear → API key (swap for `jira` if you prefer) |
| `memory` plugin | plugin | Yes | Built-in workspace memory plugin |
| `summarize-anything` skill | skill | Yes | Ships with workspace skill pack |
| `weekly-review` skill | skill | Yes | Ships with workspace skill pack |
| `telegram` plugin | plugin | Optional (for delivery) | Settings → Plugins → Telegram |

The workflow ships **disabled**. Enable from Settings → Workflows after the
above are configured.

## Customization

- **Use Jira instead of Linear** — swap `pluginId: linear` to `pluginId: jira`,
  step `fetch_completed_tickets`. Both expose a `completed_since` tool.
- **Different cadence** — change `schedule:18:00` to your preferred end-of-week
  time. Change the guard from `getDay() !== 5` to e.g. `0` for Sunday, `1` for
  Monday morning retro, etc.
- **Skip journal aggregation** — remove the `fetch_journal_entries` step and
  drop its placeholder from `summarize-anything.args.inputs`.
- **Persist only, no delivery** — remove the `deliver_retro` step. The retro
  remains saved in `memory/retros/`.

## Settings used

- `{{settings.trackedRepos}}` — array of absolute repo paths, set on the `git`
  plugin's settings page.
- `{{settings.telegramChatId}}` — set on the Telegram plugin's settings page.
- `{{date.iso}}` — runtime-provided ISO date string (e.g. `2026-05-22`).
