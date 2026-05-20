# Inbox Zero

Fetches unread email, classifies each message (archive / reply / snooze /
action), extracts action items for the ones that need attention, adds them to
your todo list, and sends a digest summary. Designed to be run hourly or on
demand.

## What it does

1. Fetches unread messages via the `email` plugin (IMAP/Gmail/Outlook)
2. Short-circuits gracefully if the inbox is empty
3. `email-triage` skill classifies each into archive / reply / snooze / action
   (with `autoArchive: true`, archive-class messages are removed immediately)
4. `action-item-extractor` skill turns action-class messages into todo items
   with extracted due dates where present
5. Appends those items to the `inbox-actions` list via the `notes` plugin
6. Composes a markdown digest via `summarize-anything`
7. Sends the digest to Telegram
8. Desktop notification with the count

## Trigger

`interval:60` — runs every 60 minutes. Also runs on demand via Workflows panel
or CLI (`horizon workflow run inbox-zero`).

For a less aggressive cadence, change to `interval:240` (4 hours) or
`schedule:09:00` (once daily before work).

## Prerequisites

| Component | Type | Required? | Where to configure |
|---|---|---|---|
| `email` plugin | plugin | Yes | Settings → Plugins → Email → IMAP/OAuth credentials |
| `notes` plugin | plugin | Yes | Built-in (workspace todo list) |
| `email-triage` skill | skill | Yes | Ships with workspace skill pack |
| `action-item-extractor` skill | skill | Yes | Ships with workspace skill pack |
| `summarize-anything` skill | skill | Yes | Ships with workspace skill pack |
| `telegram` plugin | plugin | Optional (for delivery) | Settings → Plugins → Telegram |

Required workflow settings:

- `settings.emailAccount` — account identifier registered with the email plugin
- `settings.telegramChatId` — for digest delivery (omit step `deliver_digest`
  if you don't want a digest message)

The workflow ships **disabled**. Enable from Settings → Workflows after the
email plugin is connected.

## Customization

- **Don't auto-archive** — set `autoArchive: false` in step `email-triage`. All
  archive-class messages will be flagged in the digest but left in the inbox.
- **More aggressive snooze** — pass `snoozeRules` to `email-triage` (e.g.
  newsletters → snooze 7d, recruiter mail → snooze until Saturday).
- **Different todo backend** — swap `pluginId: notes` for `pluginId: todoist`,
  `pluginId: things`, or `pluginId: linear` (each exposes `append_todos`).
- **Per-account workflows** — duplicate the workflow for each email account and
  set a different `settings.emailAccount` on each.

## Notes

- `autoArchive: true` modifies your inbox state. Test with `autoArchive: false`
  first and inspect the digest before letting it run on a schedule.
- The action-item extractor only acts on messages classified as `action` — it
  does not extract from snoozed or reply-pending messages.
- Run history with full message classifications is saved by the engine to its
  own run log; this workflow does not persist additional history beyond the
  todo list and Telegram digest.
