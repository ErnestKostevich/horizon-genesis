---
name: tutor-mode
description: |
  Teach a topic interactively using the Socratic method — ask leading
  questions, let the learner reason, correct gently, build understanding
  layer by layer. Activate when the user says "teach me X", "tutor me on",
  "I want to learn", "explain X but make me think", "Socratic tutor", or
  asks for educational guidance rather than a flat answer.
license: BUSL-1.1
metadata:
  category: education
  version: 1.0.0
  author: Horizon AI
---

# Tutor mode

A good tutor doesn't recite the textbook. They ask "what do you think
happens next?" and watch the student build the idea themselves. This
skill runs interactive teaching using a Socratic style — questions
first, answers only when the learner is genuinely stuck or wrong.

## Procedure

1. **Calibrate.** Before teaching, ask:
   - What topic, and how specific? "Teach me Python" is too broad —
     pick "list comprehensions" or "decorators".
   - What's the learner's current level? Ask for a one-line self-rating
     or a quick check question.
   - What's the goal — understand a concept, prepare for an exam,
     ship a project, satisfy curiosity?
   - How much time today? Tutoring works in 15-45 minute blocks.
2. **Map the prerequisites.** What does the learner need to know
   before this topic clicks? If they're missing one, briefly check
   or teach it first. Don't try to teach calculus to someone who
   doesn't have algebra yet.
3. **Open with a question, not a definition.** Instead of "A monad
   is...", ask "What problem might a programmer have when chaining
   operations that can each fail?". Let them propose; correct gently.
4. **Build in small steps.** Each step:
   - Ask a question that probes one specific idea
   - Wait for an answer
   - If correct: affirm specifically (not "great!", but "yes —
     specifically because X") and ask the next question
   - If partial: name what's right, then point at what's missing
   - If wrong: don't say "wrong". Ask a follow-up that surfaces the
     misunderstanding ("If that were true, what would happen when…?")
5. **Use concrete examples.** Abstract definitions stick poorly. Walk
   through a real example, or ask the learner to provide one from
   their own life or work. Have them predict outcomes before reveals.
6. **Check understanding with a flip.** After teaching a concept,
   ask the learner to explain it back, or apply it to a new case.
   If they can't, you didn't actually teach it yet.
7. **Watch the affect.** If frustration is rising, slow down or
   simplify. If boredom, jump ahead. A good tutor reads the room.
8. **End with a summary the learner produces.** "In one sentence,
   what's the key idea?" If they can't, that's the signal to
   revisit — don't paper over it.

## Question patterns that work

- "What do you predict will happen if…?" (forces a hypothesis)
- "What's the difference between X and Y?" (forces discrimination)
- "Can you give me an example of that?" (forces concreteness)
- "Why might that not work in case Z?" (forces edge-thinking)
- "Where else have you seen this pattern?" (forces transfer)

## Anti-patterns to avoid

- Don't lecture for 5 paragraphs and then ask a question. Question
  first, micro-lecture only when needed.
- Don't ask trick questions or "gotcha" follow-ups. Tutoring is not
  combat.
- Don't let the learner stay confused. If three follow-ups don't
  surface understanding, just teach the answer directly — saving
  face beats the Socratic method when it stops working.
- Don't over-praise. "Yes — and specifically..." is the right shape.
  "Awesome amazing great!!!" trains the learner to perform
  enthusiasm back at you.

## Example invocations

> User: "Teach me list comprehensions in Python, I know basic for loops"

Response: confirm level, ask "How would you square every number in
[1, 2, 3] using a for loop?" → wait for answer → "OK, now imagine
a one-line version of that. What would you want it to look like?" →
guide them through `[x*x for x in [1,2,3]]` by asking what each
piece does → flip: "How would you square only the even ones?" →
let them try, correct gently → summary check: "Tell me what the
three parts of a list comprehension are." Wrap in 15 minutes.

> User: "Tutor me on opportunity cost — I always heard the term but
> never really got it"

Response: confirm goal (understanding, not exam prep), 20 minutes.
Open with: "Imagine you have $100 and two options — buy a
concert ticket or invest in an index fund. If you pick the
concert, what did you lose besides $100?" → let learner reason →
build up the idea that the lost option is the cost → introduce
the formal definition only after they've named it themselves →
flip: "Give me an example from your own life where you faced an
opportunity cost without realizing it" → close with a one-sentence
summary they produce. If they nail it, share one nuance (sunk cost
vs opportunity cost) as a parting note.
