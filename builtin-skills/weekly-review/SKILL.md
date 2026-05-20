---
name: weekly-review
description: |
  Reflect on the past week and plan the next — surface what shipped,
  what slipped, what to drop, and what to commit to. Activate when the
  user says "weekly review", "wrap up this week", "plan next week",
  "Friday review", or invokes a Sunday/Friday end-of-week routine.
license: BUSL-1.1
metadata:
  category: productivity
  version: 1.0.0
  author: Horizon AI
---

# Weekly review

The weekly review is the cheapest productivity habit and the most
skipped one. Done well, it costs 20-30 minutes and saves hours of
drift the following week. This skill structures the reflection so
it doesn't turn into doomscrolling old to-dos.

## Procedure

1. **Pull the week's data.** Gather from anywhere available:
   - Calendar events that actually happened
   - Completed tasks from the user's todo tool
   - Commits, PRs, or shipped releases
   - Journal entries or notes from the week
   - Last week's planned-priorities list (if a prior review exists)
2. **Reflection: what shipped.** Ask the user to confirm or correct
   a short list of 3-7 things that actually shipped. "Shipped" means
   reached the intended audience — drafts don't count. Celebrate
   without inflating.
3. **Reflection: what slipped.** From last week's plan, list anything
   that didn't get done. For each, ask: still relevant? blocked? was
   the estimate wrong? Discard the ones that turned out not to matter —
   keeping zombie todos is worse than killing them.
4. **Reflection: what surprised.** One question: "what came up this
   week that you didn't plan for, and was it worth the time?" This
   is where the user notices interrupt-driven weeks early.
5. **Reflection: how did you feel.** One sentence on energy, focus,
   stress. Patterns over weeks are more important than any single
   week — if the user is on a multi-week trend of low energy,
   surface it.
6. **Planning: what's the one thing.** Identify the single most
   important outcome for next week. Not three things, not a list —
   the one thing that would make the week a success if everything
   else slipped. This is the keystone.
7. **Planning: commit to 3-5 specific deliverables.** Each must be
   specific, time-boxed, and have a clear "done" criterion. "Work on
   project X" — no. "Ship v0.3 to staging with the new auth flow" —
   yes.
8. **Planning: what are you not doing.** Equal in value to the
   commit list — a 2-3 item "not this week" list. This prevents
   scope creep and gives the user permission to say no to incoming
   requests.
9. **Output structure:**
   ```
   # Weekly Review — <week of>

   ## Past week
   ### Shipped
   - ...
   ### Slipped
   - ...
   ### Surprises
   - ...
   ### Energy
   <one sentence>

   ## Next week
   ### The one thing
   <single most important outcome>
   ### Commits
   - [ ] ...
   ### Not this week
   - ...
   ```

## Anti-patterns to avoid

- Don't carry slipped items forward by default. Each one needs an
  explicit "still matters" decision.
- Don't plan 12 things for next week. The user will fail at most of
  them and feel bad. 3-5 is the working capacity.
- Don't skip the "not this week" list. Saying no is half the value.
- Don't write a long narrative — bullets only.

## Example invocations

> User: "Friday review"

Response: pull this week's commits + completed todos + last review,
walk through 5 prompts (shipped, slipped, surprises, energy, next
week's one thing), output the structured review, end with one
encouraging sentence calibrated to actual progress.

> User: "Wrap up this week — I feel like I got nothing done"

Response: pull data; actually they shipped 4 things (3 PRs merged,
1 customer call closed), but spent 60% of focus time on an
interrupt-driven incident response. Walk through reflection: shipped
list shown explicitly to counter the "nothing done" feeling; slipped
list includes the doc-rewrite they kept punting; surprise was the
incident eating Tuesday and Wednesday; energy "low — too many
interrupts". Next week's one thing: "no incidents = ship the
doc-rewrite to a draft state". Commit list of 3, not-this-week list
includes "do not take on the customer-support rota you were asked
about". End with: "You shipped more than you remember. Now ship the
doc."
