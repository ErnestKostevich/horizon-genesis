---
name: mood-tracker
description: |
  Log daily mood with a numeric score plus a one-line note, then analyze
  trends and surface patterns over weeks and months. Activate when the
  user says "log my mood", "track how I'm feeling", "mood check-in",
  "how have I been this week", "show my mood trend", or runs a daily
  check-in routine.
license: BUSL-1.1
metadata:
  category: personal
  version: 1.0.0
  author: Horizon AI
---

# Mood tracker

Mood data is only useful if it's logged consistently and reviewed
honestly. This skill makes logging take 15 seconds and pulls back
something insightful when the user looks at the data — patterns,
correlations, and gentle nudges, not a diagnosis.

## Procedure

1. **Logging — ask three things only:**
   - **Score**: 1-10 (1 = worst day in memory, 10 = best). Keep the
     scale simple. Don't introduce multiple dimensions on day one.
   - **Single word**: one word to describe today (anxious, calm,
     restless, energized, flat).
   - **Optional note**: one short sentence of context. Don't push
     the user to elaborate.
2. **Store the entry.** Persist to the user's journal/memory store:
   `{ date, score, word, note, time_logged }`. Do not require any
   field beyond the score — fewer fields = more consistent logging.
3. **Don't editorialize on log.** When the user logs a 3/10, don't
   say "I'm sorry you're feeling down". Respond neutrally and warmly:
   "Logged. Anything you want to write about it, or just rest the
   number there?". Let them choose.
4. **Trend analysis — when asked**: compute and surface:
   - **Last 7 days**: average, trend (up/down/flat), best and worst
   - **Last 30 days**: average, trend, distribution
   - **Day-of-week pattern**: do Mondays consistently dip?
   - **Streaks**: longest run of 7+ days, last bad streak
   - **Word cloud**: which words appeared most often this period
5. **Pattern detection.** Flag correlations only when there's enough
   data and the pattern is striking, not every faint signal:
   - "Your last 4 Sundays scored 3-5/10. Worth noticing."
   - "After every gym day, the next day was 7+/10."
   - "Mood was consistently lower in the week of <event>."
   Always frame as observations, never as causes.
6. **No diagnosis.** This is a log, not a therapist. If the trend is
   sustained low (e.g., 14+ days below 4/10), gently suggest talking
   to a professional, but do not pathologize. Be careful with
   sensitive language.
7. **Output formats:**

   Logging:
   ```
   Logged: 6/10 — "restless" — "couldn't focus, fine otherwise"
   7-day avg: 6.4 (steady)
   ```

   Trend on request:
   ```
   ## Mood — last 30 days
   Average: 6.1 (up from 5.6 last month)
   Best: 8/10 (May 12 — "energized")
   Worst: 3/10 (May 4 — "flat")

   ## Patterns
   - Mondays average 4.5 — lower than other days
   - Weeks with 3+ gym days averaged 7.0 vs 5.7 without

   ## Word cloud (top 5)
   tired (8), curious (6), calm (5), restless (4), focused (4)
   ```

## Anti-patterns to avoid

- Don't make logging more than 15 seconds. Friction kills consistency.
- Don't try to be a therapist. You're a tracker.
- Don't claim causation. "Correlated with" is the strongest you should go.
- Don't surface every faint pattern. Only flag genuinely striking ones.
- Don't comment on low scores in a way that feels surveilled. Some
  days are bad. The user knows.

## Example invocations

> User: "Mood check-in: 5, foggy, didn't sleep well"

Response: log it; respond "Logged. 7-day avg holding at 6.0 — you've
been steady. Want me to surface anything from the last week, or
leave it?"

> User: "Show my mood trend for the last month"

Response: pull 30 days of entries (28 logged, 2 missed). Output:
average 6.1 (up from 5.6 last month), best 8/10 on May 12
("energized"), worst 3/10 on May 4 ("flat"). Patterns: Mondays
average 4.5 vs other days 6.4 — strikingly lower; weeks with 3+
gym days averaged 7.0 vs 5.7 without — strong correlation, not
causation. Word cloud: tired (8), curious (6), calm (5), restless
(4), focused (4). End with a single observation, no advice: "Your
Monday dip is consistent enough to be worth a name."
