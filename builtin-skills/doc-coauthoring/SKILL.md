---
name: doc-coauthoring
description: |
  Structured spec, RFC, or design-doc drafting workflow — context
  transfer, iterative refinement, reader verification. Activate when
  the user says "write a spec", "draft an RFC", "design doc for X",
  "PRD", "technical proposal", "decision doc", "architecture doc".
license: BUSL-1.1
metadata:
  category: writing
  version: 1.0.0
  author: Horizon AI
---

# Doc co-authoring workflow

Specs and RFCs are decision tools, not novels. The goal is to make a
reader who has 5 minutes able to leave a useful comment. The workflow
below builds the doc in passes — context first, then content, then
readability.

## Procedure

1. **Context transfer (no writing yet).** Interview the user with
   these questions, one at a time, in order:
   - What problem are you solving? (one sentence)
   - Who is affected if you solve it? Who if you don't?
   - What's the current state — what exists today?
   - What's the proposed change?
   - What did you consider but reject, and why?
   - What's the rollout plan? Reversibility?
   - Who needs to approve, and by when?
   Don't move on until each question has a real answer.
2. **Pick a template.** Match the genre:
   - **PRD** (product requirements): problem, users, requirements,
     non-goals, open questions, success metrics.
   - **RFC** (technical proposal): summary, motivation, design,
     alternatives, drawbacks, rollout, FAQ.
   - **ADR** (architecture decision): context, decision, consequences.
   - **Postmortem**: timeline, impact, root cause, what went well,
     what didn't, action items.
3. **Draft the summary first.** TL;DR in 3-5 sentences at the top.
   This is what 80% of readers will read. Make it the load-bearing
   section.
4. **Draft sections in priority order.** Motivation → Proposed design
   → Alternatives considered → Drawbacks → Rollout. Show after each
   section, don't dump the whole draft.
5. **Reader simulation pass.** Read the draft pretending to be:
   - A skeptical reviewer who will ask "did you consider X?"
   - A new team member with no context
   - The person who has to implement this
   For each, list questions they'd ask. Add answers to the FAQ or
   inline.
6. **Cut.** First-draft RFCs are usually 30% too long. Look for:
   - Background that the audience already knows
   - "We considered X but rejected it" with no real analysis (delete or fix)
   - Hedged claims that could be made directly
7. **Final pass.** Add: open questions list (so reviewers know what
   to comment on), decision deadline, approver list.

## Output structure

```
# <Title>: <one-line summary>

**Status**: Draft | In review | Accepted | Rejected
**Author**: <name>
**Reviewers**: <names>
**Decision needed by**: <date>

## Summary
<3-5 sentences>

## Motivation
<why this matters now>

## Proposal
<the design>

## Alternatives considered
<and why rejected>

## Drawbacks
<honest>

## Open questions
<for reviewers to weigh in on>
```

## Anti-patterns to avoid

- Don't write the doc before the context transfer is done.
- Don't bury the proposal under three pages of background.
- Don't list alternatives without explaining why each was rejected.
- Don't ship a draft without an explicit "decision by" date.

## Example invocation

> User: "Help me write an RFC for migrating our auth system to OAuth"

Response: run through the 7 context questions, draft summary + motivation,
share with user, iterate, fill in alternatives + drawbacks, do the
reader-simulation pass, output the final RFC.
