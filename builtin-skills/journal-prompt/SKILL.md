---
name: journal-prompt
description: |
  Generate a daily journaling prompt calibrated to time of day, mood,
  and recent journal entries — light morning prompts, reflective evening
  ones. Activate when the user says "journal prompt", "give me something
  to journal about", "morning pages prompt", "what should I write about
  today", or invokes a journaling routine.
license: BUSL-1.1
metadata:
  category: personal
  version: 1.0.0
  author: Horizon AI
---

# Journal prompt

A journaling habit lives or dies on what you write about. Too generic
("how are you feeling?") and it gets boring. Too pointed and the user
freezes. This skill picks the right prompt for the moment — light when
they need momentum, deep when they need processing.

## Procedure

1. **Read context cues.** Before picking a prompt, check:
   - Time of day: morning prompts forward-look, evening prompts
     reflect on the day
   - Last few journal entries (if accessible): note recurring themes,
     don't pick a prompt the user already covered yesterday
   - Recent mood data (if tracked): if they've been low, pick gentler
     prompts; if curious, pick exploratory ones
   - Day of week: Sundays do well with weekly recap, Mondays with
     intentions
2. **Pick a category.** Vary across days — don't run the same
   category twice in a row:
   - **Reflection**: what happened, how did it land
   - **Gratitude**: small specific things that went well
   - **Intention**: what do you want to do today/this week
   - **Curiosity**: open exploratory question, no right answer
   - **Letter**: write to someone (self, future, past, hypothetical)
   - **Sensory**: describe a specific moment in detail
   - **Decision**: think through a real choice the user is facing
3. **Pick a single prompt.** One question or one instruction. Not a
   list of three. The user shouldn't be answering a survey.
4. **Calibrate depth.** A morning prompt for someone with 10 minutes:
   "What's one thing you'll do today that future-you will thank you
   for?". An evening prompt with no time pressure: "Write a letter
   to yourself from a year ago. What would you tell that person?".
5. **Suggest a duration.** 5-minute prompts for momentum, 15-minute
   for processing. Mention it so the user picks the right time.
6. **Output structure:**
   ```
   ## Today's prompt (<5 or 15> min)

   <single prompt sentence>

   <optional one-sentence framing if the prompt needs context>

   ---
   <one line: alternate prompt if this doesn't fit>
   ```
7. **Track to avoid repetition.** Append the chosen prompt to a
   running log so future invocations can vary. If a user marks a
   prompt as "this hit", note that for similar future picks.

## Prompt library (sample, expand over time)

- "What did you say yes to today that you wish you'd said no to?"
- "Describe your morning in five sensory details."
- "What's one belief you held a year ago that you no longer hold?"
- "Write a thank-you note to someone you've never told."
- "If today had a soundtrack, what would the first song be? Why?"
- "What's the smallest thing that brought you genuine pleasure today?"
- "What are you avoiding? Just name it. You don't have to solve it."

## Anti-patterns to avoid

- Don't give multiple prompts and ask the user to pick. Pick one.
- Don't ask for "your goals" or "your dreams" — vague abstract
  questions kill momentum.
- Don't repeat last week's prompt verbatim.
- Don't write the answer for them. The point is they journal.

## Example invocations

> User: "Morning journal prompt" (Tuesday, 7am, no recent journal data)

Response: pick intention category, output: "What's one thing you'll
do today — not because you should, but because future-you will be
grateful you did? (5 minutes)". Alternate offered if it doesn't fit.

> User: "Evening prompt" (Sunday, 9pm, recent mood data shows a
> stressful week)

Response: pick reflection category, calibrate to gentleness given
mood signal, output: "Pick one moment from this week that felt
heavier than it needed to. What did it really cost you? Write
without trying to fix it. (15 minutes)". Alternate offered:
"If next week could only have one promise to yourself, what
would it be?"
