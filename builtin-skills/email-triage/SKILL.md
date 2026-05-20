---
name: email-triage
description: |
  Score an inbox or thread list and recommend archive / reply / snooze /
  flag for each. Activate when the user says "triage my inbox",
  "what should I reply to", "clean up email", "what's urgent",
  "process my inbox", or pastes a list of email subjects and senders.
license: BUSL-1.1
metadata:
  category: writing
  version: 1.0.0
  author: Horizon AI
---

# Email triage

The cost of email is decisions, not reading. Each message gets one
decision: archive, reply now, snooze with a date, or flag for follow-up.

## Procedure

1. **Get the list.** Ask the user to paste a list of emails — sender,
   subject, snippet, received time — or if integrated with an email
   tool, fetch the last 50 unread. Aim to triage in batches, not all
   at once.
2. **Classify each message.** Pick exactly one bucket per email:
   - **Archive (no action)**: newsletters they're not reading,
     notifications, auto-replies, social cc's, marketing.
   - **Reply now**: questions directly addressed to them, urgent
     time-sensitive items (interview slots, security alerts),
     anything 2-line-replyable.
   - **Snooze with date**: things that need action but not today —
     suggest a specific return date based on the content
     ("snooze to Monday 9am" for a Friday-evening request).
   - **Flag / follow up**: needs a deep response or task work;
     surfaces for the user to handle during focus time, not now.
3. **Score signals.** Use these heuristics to decide:
   - Direct "To:" with a question → reply now
   - "CC:" or list-recipient → usually archive unless explicitly tagged
   - Auto-generated (no-reply@, notifications@, github.com) → archive
   - Repeated nudges from the same person → reply now or escalate
   - Internal vs external sender → external usually higher priority
   - Subject contains "URGENT" / "ASAP" → read body before trusting it;
     real urgency rarely needs the label
4. **Surface VIPs separately.** Ask the user upfront for 3-5 VIP
   senders (manager, top customers, partner). Anything from a VIP
   defaults to "reply now" unless clearly auto-generated.
5. **Draft replies for the reply-now bucket.** For each, draft a
   2-4 sentence response. Show them inline so the user can paste
   and send with one tweak.
6. **Output format:**
   ```
   ## Reply now (4)
   - [Alice] Project X status request → drafted below
   - …

   ## Snooze (7)
   - [LinkedIn] new connection → snooze to Saturday

   ## Archive (23)
   - newsletters, notifications, listserve

   ## Flag (2)
   - [Bob] Q3 planning doc — needs review, ~30 min focus block
   ```
7. **Suggest unsubscribe.** If 3+ messages from the same marketing
   sender are in archive, recommend unsubscribing to cut future load.

## Anti-patterns to avoid

- Don't read past the first 100 emails in one pass — fatigue degrades
  decision quality.
- Don't suggest replying to every email; archive is often the right call.
- Don't draft a reply longer than 4 sentences; if it needs more, flag instead.

## Example invocation

> User: "Triage my inbox" (pastes 30 emails)

Response: classify each, output the 4 buckets, draft replies for the
"reply now" set, point out 2 marketing senders to unsubscribe from.
