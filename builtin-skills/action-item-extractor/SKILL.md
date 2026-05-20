---
name: action-item-extractor
description: |
  Pull actionable tasks out of any text — emails, chat threads, meeting
  notes, documents — with owner, action, and deadline for each. Activate
  when the user says "what are my action items", "extract tasks from
  this", "what do I need to do", "turn this into a todo list", or pastes
  any text that mixes discussion with implied tasks.
license: BUSL-1.1
metadata:
  category: productivity
  version: 1.0.0
  author: Horizon AI
---

# Action item extractor

Most things people write contain tasks buried in prose. "We should
probably look into X" is an action item nobody owns. "Let me know
when you've reviewed the doc" is two tasks. This skill pulls them
out, assigns owners, and gives them deadlines so they can actually
get done.

## Procedure

1. **Take the input.** Ask for the source: an email thread, meeting
   transcript, chat log, document, or just freeform notes. Anything
   with implied work in it.
2. **Identify the participants.** Names in the source plus any
   "I/me/my" references — those resolve to the writer. If ownership
   is ambiguous, ask before guessing.
3. **Scan for action verbs.** Tasks usually start with: "send",
   "review", "follow up", "schedule", "check", "investigate",
   "decide", "draft", "ship", "test", "ping", "ask". Also look for
   "I'll", "we should", "can you", "let me know when", "by Friday".
4. **Decide what's actually actionable.** Filter out:
   - Aspirational vague statements ("we should improve X someday")
   - Discussion items without a clear next step
   - Past-tense items already done
   - Hypothetical ("if X then Y")
5. **Assign each item: owner, action, deadline.**
   - **Owner**: a single person. If the source says "someone should",
     either assign the writer, the recipient, or flag for clarification.
     Do not assign "team" or "we".
   - **Action**: imperative verb + specific object. "Improve docs" → no.
     "Add usage example to README API section" → yes.
     If the source is vague, sharpen it.
   - **Deadline**: explicit date. If the source says "soon", pick a
     reasonable default (3 business days for emails, end-of-week for
     meetings) and flag for confirmation.
6. **Categorize by urgency.** Pick one per item:
   - **Now**: explicit deadline within 24h, or blocking others
   - **This week**: deadline within a week
   - **Later**: deadline 1+ week out, or no urgency signal
7. **Output structure:**
   ```
   ## Now (2)
   - [ ] Ernest — Reply to vendor with signed contract — by Thu 5pm
   - [ ] Ernest — Push hotfix for login bug — today

   ## This week (5)
   - [ ] Alice — Send Q3 roadmap draft for review — by Fri
   - ...

   ## Later (3)
   - ...

   ## Flagged for clarification (1)
   - "Look into perf issue" — owner? deadline?
   ```

## Anti-patterns to avoid

- Don't extract "tasks" that are really just opinions. "X should be
  faster" is not an action item.
- Don't assign ownership to "everyone" or "team" — pick a person.
- Don't accept vague deadlines like "soon" without flagging.
- Don't combine two tasks into one bullet. Each owner-action-deadline
  triple is its own line.

## Example invocations

> User: pastes a 200-line Slack thread about Q3 launch

Response: extract 12 candidate items, drop 4 as discussion-only,
sharpen 8 into action items with named owners and dates, group by
urgency, flag 2 with vague deadlines for the user to confirm.

> User: "Pull tasks out of this email" (pastes a back-and-forth
> email thread between user and a client)

Response: parse 6 messages, identify 4 actionable items: 2 owned by
user ("send revised SOW by Tuesday", "schedule kickoff call this
week"), 1 owned by client ("provide brand assets — no deadline
specified, suggested EOW"), 1 ambiguous ("someone needs to loop in
legal" — flag for clarification). Output grouped by urgency with
"This week" containing the SOW (concrete deadline) and the kickoff
(no date, suggest Wednesday).
