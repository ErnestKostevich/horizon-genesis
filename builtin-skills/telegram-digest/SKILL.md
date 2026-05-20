---
name: telegram-digest
description: |
  Daily digest of Telegram chats and channels — what happened, what needs
  your reply, what to ignore. Activate when the user says "Telegram
  digest", "what's new on Telegram", "catch me up on Telegram", "summarize
  my Telegram", or runs a scheduled daily digest job over Telegram messages.
license: BUSL-1.1
metadata:
  category: communication
  version: 1.0.0
  author: Horizon AI
---

# Telegram digest

Telegram is two things stacked: 1:1 chats that matter and channels
that mostly don't. A good digest separates them, surfaces messages
that actually need a reply, and lets the channels become background
the user can skim or skip.

## Procedure

1. **Connect to the source.** Use the Telegram integration if
   available, or ask the user to paste a recent export. Pull
   messages from the last 24 hours by default.
2. **Classify by chat type.**
   - **DMs (1:1)**: anything from a real person addressed to the user
   - **Group chats**: small private/team groups where the user
     participates
   - **Channels**: broadcast channels the user subscribes to but
     rarely posts in
   - **Bots**: notifications, automated services
3. **DMs — prioritize.** For each unread DM:
   - Quote 1-line context of the latest message
   - Detect if it ends with a question or `?`
   - Flag if it's been >24h unanswered
   - Group by sender so a flurry of 8 messages from one person
     becomes one entry
4. **Group chats — extract signal.** For each active group:
   - Count messages and active participants
   - Summarize the topic in one sentence
   - Flag if the user was @-mentioned (those need attention)
   - If a decision or action item appeared, surface it
5. **Channels — skim mode.** For each channel:
   - List top 1-2 headlines if newsy
   - Skip entirely if it was just emoji reactions or short reposts
   - Don't summarize content the user didn't ask about
6. **Suppress bots and noise.** Unless the user has flagged a bot as
   important, collapse all bot notifications into one line:
   "12 bot messages (deploys, GitHub notifs) — open if needed".
7. **Output structure:**
   ```
   # Telegram digest — <date>

   ## Needs your reply (3)
   - <sender>: "<context>" — 6 hours ago
   - ...

   ## Group chats
   ### <Group name> (12 msgs, 4 people)
   <topic in one sentence>
   <@-mention flag if applicable>

   ## Channels
   - <Channel>: <headline> | <headline>
   - <Channel>: quiet

   ## Bots
   12 notifications collapsed
   ```

## Customization

- The user can pin VIP DMs to always appear at the top.
- Channel digest can be limited to a curated list — by default,
  exclude high-volume noisy channels.
- Bot whitelist: a few bots (your team's CI, alerting) might be
  promoted out of the noise bucket.

## Anti-patterns to avoid

- Don't try to summarize an active channel with 500 messages — skim
  and link, don't synthesize.
- Don't reply on the user's behalf unless they explicitly opted in.
- Don't include forwarded memes or meme-only messages in the digest.
- Don't show every channel — surface only those with meaningful
  movement today.

## Example invocations

> User: "Telegram digest"

Response: pull last 24h, find 4 DMs needing reply (1 from VIP,
3 routine), 2 active group chats including a project group where
the user was @-mentioned, 3 channels with newsy headlines, collapse
8 bot notifications; output a 250-word structured digest.

> User: "What's new on Telegram this morning" (Monday after a quiet
> weekend)

Response: pull last 48h since user last checked. DMs: 1 from VIP
(reply needed — they asked a direct question Sunday night), 2 from
non-urgent friends. Group chats: family group quiet, project group
had 4 messages mid-Sunday but nothing assigned. Channels: 3 of 5
subscribed channels had zero activity (label "quiet"); 2 had newsy
items worth a glance. Bots: 6 deploy notifications collapsed. Tone
suggestion: "the VIP message is the only one that actually needs
you today — handle it before anything else."
