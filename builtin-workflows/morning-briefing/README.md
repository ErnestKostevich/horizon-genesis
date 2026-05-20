# Morning Briefing

A daily 8:00 AM briefing that composes calendar events, email triage, top tech
news, and weather into a single markdown digest delivered to your channel of
choice.

## What it does

1. Pulls today's calendar events via the `calendar` plugin
2. Runs the `email-triage` skill on unread mail since yesterday
3. Fetches Hacker News best stories via the `web-fetch` plugin (`extract_text`)
4. Fetches a 1-line weather summary from `wttr.in`
5. Composes a markdown briefing via the `summarize-anything` skill
6. Delivers via the `telegram` plugin (configurable to email, Slack, etc.)
7. Fires a local desktop notification on success

## Trigger

`schedule:08:00` — fires every day at 08:00 local time.

To customize the time, edit `trigger` in `workflow.json`:

- `schedule:07:30` — daily 7:30 AM
- `schedule:09:00` — daily 9:00 AM
- `cron:0 8` — also supported (minute hour)

## Prerequisites

| Component | Type | Required? | Where to configure |
|---|---|---|---|
| `calendar` plugin | plugin | Yes | Settings → Plugins → Calendar (provider OAuth) |
| `email-triage` skill | skill | Yes | Ships with workspace skill pack |
| `summarize-anything` skill | skill | Yes | Ships with workspace skill pack |
| `web-fetch` plugin | plugin | Built-in | No setup needed |
| `telegram` plugin | plugin | Yes (for delivery) | Settings → Plugins → Telegram → Bot Token + chat ID |

The workflow ships **disabled** (`enabled: false`). Enable it from
Settings → Workflows after confirming prerequisites.

## Customization

- **Delivery channel** — replace the final `plugin` step with `email`, `slack`,
  or `discord` plugin (any plugin exposing a `send_message` tool works).
- **News source** — change the URL in step `fetch_top_news` to a different feed
  (e.g. `https://lobste.rs/`, `https://www.reuters.com/technology/`).
- **Weather city** — change `https://wttr.in/?format=3` to
  `https://wttr.in/Tallinn?format=3` (or any city slug).
- **Skip a section** — set `stopOnError: false` on the section step and remove
  its placeholder from `summarize-anything.args.inputs`.

## Settings placeholders

`{{settings.telegramChatId}}` is resolved at runtime from the Telegram plugin's
own settings store. If the placeholder is unresolved the step fails gracefully
and the workflow continues to the desktop notification.
