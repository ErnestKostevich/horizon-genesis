---
name: slack-summary
description: |
  Summarize a Slack thread or channel into decisions, action items, and
  open questions — so you can catch up on a 200-message thread in 60
  seconds. Activate when the user says "summarize this Slack thread",
  "what did I miss in #channel", "catch me up on Slack", or pastes
  a Slack export.
license: BUSL-1.1
metadata:
  category: communication
  version: 1.0.0
  author: Horizon AI
---

# Slack summary

Slack threads have a particular shape: a question, twelve emoji
reactions, three tangents, two semi-decisions, and an action item
buried at message 87. This skill extracts the signal and discards
the noise.

## Procedure

1. **Get the source.** Ask for either:
   - A paste of the thread (messages with usernames and timestamps)
   - A Slack export file (JSON)
   - A connected Slack integration with channel + time range
2. **Strip the noise.**
   - Drop emoji-only reactions (but count them as signal — a message
     with 10 reactions is important)
   - Drop "thanks!", "lol", and "👀" type acknowledgments
   - Drop bot pings, CI notifications, deploy bots — unless they're
     the topic of conversation
   - Collapse repetitive back-and-forth on the same micro-point
3. **Identify the topic.** What was this thread or channel about
   during this window? One sentence. If the conversation drifted,
   note both the starting topic and where it ended up.
4. **Extract decisions.** Look for explicit decisions:
   "let's go with X", "approved", "yeah do it", "we'll skip Y for now".
   Also implicit decisions where nobody objected after a proposal —
   note those as "tentative".
5. **Extract action items.** "I'll do X", "@person can you Y", "let's
   ship Z by Friday". Owner + action + deadline. Use the
   `action-item-extractor` skill's rules.
6. **Extract open questions.** Things raised but unanswered. These
   are often the most valuable — a thread can scroll past a real
   question without anyone seeing it.
7. **Sentiment signal.** Note if the thread was contentious, urgent,
   or routine. One word. This helps the user prioritize re-engaging.
8. **Output structure:**
   ```
   ## Thread: <topic> — <channel>, <date range>
   <n messages, x participants>

   ## TL;DR
   <one sentence>

   ## Decisions
   - <decision> (<participant>)

   ## Action items
   - [ ] <owner> — <action> — by <date>

   ## Open questions
   - <question> (raised by <participant>)

   ## Tone
   <one word: routine, contentious, urgent, celebratory>
   ```

## Heuristics for noisy threads

- Sort participants by message count and quote the top 3-5 voices.
  A 200-message thread usually has 5-8 people doing 80% of the talking.
- If the thread is huge, summarize the first 30 messages (the framing),
  the last 30 (where it landed), and the loudest 30 in between (the
  contested middle).
- Threads with high disagreement rarely converge in-thread. Flag for
  follow-up meeting.

## Anti-patterns to avoid

- Don't quote messages verbatim — summarize.
- Don't include reaction counts unless they're load-bearing
  (e.g., "12 people 👍'd this decision" is signal).
- Don't pretend a non-decision was a decision. "Let's think about it"
  is not approval.
- Don't surface every joke. Comic relief lines aren't the topic.

## Example invocations

> User: "Catch me up on #eng-platform from the last 48 hours"

Response: pull the channel, find 3 active threads, summarize each,
flag the one tagged @user (postgres migration discussion), output:
"2 decisions made, 1 action item assigned to you, 1 unresolved
question about retention policy."

> User: "Summarize this thread" (pastes a 60-message Slack thread
> about whether to launch a feature flag now or after the holidays)

Response: identify the central question (launch timing), strip out
the 14 emoji-only and ack messages, group the remaining 46 messages
by stance (pro-now: 4 voices, defer: 3 voices, undecided: 2 voices).
TL;DR: "Team leaning toward defer-to-January but no decision made."
Decisions: none. Action items: 1 (PM to write a one-pager on
holiday-traffic risk by Wednesday). Open questions: "what's the
actual on-call coverage Dec 24-31?". Tone: contentious. Flag for
follow-up sync.
