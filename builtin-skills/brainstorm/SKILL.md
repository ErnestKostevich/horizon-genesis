---
name: brainstorm
description: |
  Structured brainstorm session using techniques like SCAMPER, Six
  Thinking Hats, "Yes, and", or worst-possible-idea — to break out of
  the obvious answers. Activate when the user says "brainstorm", "help
  me think through", "I'm stuck on", "ideas for", "generate options",
  or wants more than a quick list of suggestions.
license: BUSL-1.1
metadata:
  category: creative
  version: 1.0.0
  author: Horizon AI
---

# Brainstorm

A bad brainstorm is "give me 10 ideas about X" — the model spits out
10 obvious things and the user is no further along. A good brainstorm
forces angles the user wouldn't reach alone. Pick a technique that
matches the kind of stuck they're in.

## Procedure

1. **Understand the prompt.** Ask the user for:
   - The problem or topic, in one sentence
   - What "good" looks like — practical solution, wild ideas,
     business strategy, creative concept, naming?
   - Any constraints (budget, time, audience, must-have features)
   - What they've already tried (so you don't re-suggest it)
2. **Pick a technique.** Match technique to need:
   - **SCAMPER**: improving an existing thing (Substitute, Combine,
     Adapt, Modify, Put to other use, Eliminate, Reverse)
   - **Six Thinking Hats** (de Bono): evaluating a decision from
     multiple angles (white = facts, red = emotion, black = risks,
     yellow = benefits, green = creative, blue = process)
   - **Worst possible idea**: when the user is over-criticizing —
     generate deliberately bad ideas, then flip them
   - **5 whys**: when the surface problem might not be the real one
   - **Crazy 8s**: 8 ideas in 8 minutes, no filter — for visual
     or UX-heavy problems
   - **Analogies**: solve the user's problem as if it were a
     different domain ("how would a chef solve this?")
3. **Run the technique honestly.** Don't fake-brainstorm with 3
   safe ideas. If using SCAMPER, run every letter. If using Six
   Hats, give each hat at least 2 contributions. If a hat is empty,
   say so — "no facts changed, this is purely an emotional read".
4. **Generate quantity first, quality second.** Aim for 15-25
   raw ideas before any filtering. Bad ideas spark good ones.
   Don't stop at 5.
5. **Cluster and prioritize.** Group ideas into 3-5 clusters by
   theme. From each cluster pick 1-2 strongest candidates. End
   with a top-3 shortlist and one wildcard.
6. **Name the next step.** For each shortlisted idea, what's the
   smallest move to test or develop it? Brainstorms die when no
   action follows.
7. **Output structure:**
   ```
   ## Problem
   <restated>

   ## Technique
   <chosen + one-line why>

   ## Generation
   <organized by technique steps — all raw ideas visible>

   ## Clusters
   ### <Theme 1>
   - idea, idea, idea
   ### ...

   ## Top 3 + 1 wildcard
   1. <idea> — next step: <action>
   2. ...
   Wildcard: <unusual but interesting>
   ```

## When to switch techniques

- If after 10 minutes the ideas all sound similar → switch to
  worst-possible-idea or analogies to break the frame.
- If the user keeps shooting ideas down → switch to "Yes, and"
  building mode.
- If the user can't pick anything → switch to Six Hats to evaluate
  the top candidates from multiple angles.

## Anti-patterns to avoid

- Don't generate 5 obvious ideas and call it brainstorming.
- Don't let the user critique mid-generation. Separate generation
  and evaluation phases explicitly.
- Don't grade the ideas yourself before showing them. Surface them
  raw; let the user filter.
- Don't pick a technique without explaining why — the user should
  learn to pick their own next time.

## Example invocations

> User: "Brainstorm ways to grow our podcast audience, budget $0"

Response: confirm constraints, pick "SCAMPER applied to current
distribution"; generate 22 ideas across the 7 SCAMPER prompts;
cluster into 4 themes (audience overlap, format experiments,
content repurposing, community); shortlist 3 with next steps;
wildcard "release the worst episode publicly with director's
commentary".

> User: "I'm stuck on whether to take this job offer or stay at
> my current company — help me think it through"

Response: pick Six Thinking Hats — best fit for a real decision
with emotional weight. Walk through each hat in turn:
- White (facts): salary delta, equity terms, role scope, location
- Red (feelings): what does each path actually feel like in your gut
- Black (risks): what could go wrong with each, what's hard to undo
- Yellow (benefits): what's the upside of each, beyond the obvious
- Green (creative): hybrid options (negotiate stay, deferred start,
  trial sabbatical)
- Blue (process): who else should you talk to, what's the decision
  deadline, what would make you regret rushing
End with 3 surfaced considerations the user hadn't named themselves
and one next step ("Talk to two people in the new role about what
their first 6 months were actually like — by Friday.").
