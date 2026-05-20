---
name: discord-moderator
description: |
  Moderate a Discord server — flag toxicity, spam, scams, raid behavior,
  and rule violations with a recommended action for each. Activate when
  the user says "moderate this channel", "scan recent Discord messages",
  "check for spam in", "any rule breakers", or when running a scheduled
  moderation sweep over a Discord server.
license: BUSL-1.1
metadata:
  category: communication
  version: 1.0.0
  author: Horizon AI
---

# Discord moderator

Discord moderation done badly is a mute-button speedrun. Done well, it
flags genuine bad behavior, surfaces the context behind it, and leaves
the final call to a human mod. This skill is an assistant, not an
autoplayer — every action recommendation is a recommendation.

## Procedure

1. **Scope the scan.** Ask which server and channel(s), and what
   window. Default to the last 1 hour for a quick sweep, last 24
   hours for a daily review. If a user is reported, focus on their
   recent messages across all channels they posted in.
2. **Run pattern checks.** For each message look for:
   - **Slurs and hate speech**: direct slurs, dog-whistles in
     context. False positives matter — flag, don't auto-act.
   - **Targeted harassment**: repeated negative messages at one
     user, doxxing attempts, threats.
   - **Spam**: identical or near-identical messages across channels
     or users in a short window (raid signature).
   - **Scams**: Nitro phishing links, fake "support" DMs, crypto
     pump-and-dump, anything with `discord-nitro.gift` style
     typosquats. Check links carefully.
   - **NSFW in safe channels**: image hashes against known sets,
     or text-based explicit content in non-NSFW channels.
   - **Off-topic spam**: bot-like behavior, ad posting, server
     advertising.
3. **Score severity** per finding:
   - **Critical**: doxxing, credible threats, mass-spam raid in
     progress, active scam link being shared
   - **High**: slurs, targeted harassment, NSFW in safe channels
   - **Medium**: low-effort spam, off-topic ads, suspected alt accounts
   - **Low**: minor rule bends, off-topic chat
4. **Recommend an action** per finding:
   - Critical → recommend immediate ban + delete + notify mods
   - High → recommend mute (24h) + delete + warn
   - Medium → recommend warn + delete spam
   - Low → recommend nothing or a polite redirect
5. **Surface context.** For each flagged user, include: account age,
   join date to this server, message count, prior warnings if known.
   A 2-day-old account spamming is very different from a 3-year
   regular having a bad day.
6. **Do not act unilaterally.** Output recommendations; a human mod
   approves. If running in auto-mode (user opted in for low-severity
   spam auto-delete), still log every action with reason.
7. **Output structure:**
   ```
   ## Moderation sweep — <server> / <channel> / <window>
   <n messages scanned, x users, y findings>

   ### Critical (1)
   - <user>: <reason> — message link — recommend BAN
     Context: account 2 days old, no prior history

   ### High (2)
   - ...

   ### Medium (3)
   - ...

   ### Low (5)
   - ...

   ## Patterns
   <one line if a raid or coordinated behavior detected>
   ```

## Anti-patterns to avoid

- Don't auto-ban on a single message unless it's clearly a scam link
  or doxx. Bans are hard to reverse for the user's trust.
- Don't flag sarcasm or in-group jokes between regulars without
  context.
- Don't ignore patterns. Three "medium" messages from one user in
  10 minutes is a raid signature, not three independent events.
- Don't quote or republish the offending content in the report —
  link to the message instead, especially for slurs and NSFW.

## Example invocations

> User: "Run a moderation sweep on #general for the last hour"

Response: scan 340 messages from 47 users, find 1 critical (Nitro
phishing link from a 1-day-old account), 2 high (one slur, one
targeted harassment), 4 medium (off-topic ads); output structured
findings with recommended actions and account context; ask the mod
to approve before any action.

> User: "User @newperson123 was reported, check their recent
> activity"

Response: pull the user's last 7 days of messages across all
channels they posted in (43 messages, 5 channels). Account age:
4 days. Findings: 2 high-severity messages in #help (using a slur
casually in two separate conversations), 6 medium messages (low-
effort spam in #off-topic), no critical. Pattern: account is
behaving like a regular who tests boundaries, not a raid bot —
likely an alt or a real new user with poor norms. Recommend:
warn + 24h mute, with a note from a mod explaining the server's
zero-tolerance rule. Do not ban yet — give the user a chance to
adjust if they're genuine.
