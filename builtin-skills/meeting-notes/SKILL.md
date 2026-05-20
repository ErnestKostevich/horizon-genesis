---
name: meeting-notes
description: |
  Transcribe and structure raw meeting notes or audio transcripts into
  clean summary with decisions, action items, and open questions. Activate
  when the user shares a transcript or recording, says "clean up my
  meeting notes", "summarize this meeting", "what did we decide", or
  pastes raw notes from a call.
license: BUSL-1.1
metadata:
  category: productivity
  version: 1.0.0
  author: Horizon AI
---

# Meeting notes

Raw transcripts are exhausting. Three days later nobody remembers what
was decided, and the action items never made it to a tracker. This skill
takes raw notes or a transcript and produces something useful: a one-line
summary, the decisions, the action items with owners, and the open
threads worth revisiting.

## Procedure

1. **Get the source.** Ask for the transcript or pasted notes. If they
   share an audio file, ask if a transcript exists; if not, request one
   before proceeding — transcription is a separate step.
2. **Identify the participants.** List who was in the meeting. If names
   weren't in the transcript, ask. Owner assignment in step 5 depends
   on this.
3. **Extract the agenda or topic clusters.** Skim the transcript and
   group discussion into 3-6 topic blocks. This is the spine of the
   summary — each block becomes its own section.
4. **For each topic, capture three things:**
   - **What was discussed**: 1-2 sentences of context
   - **What was decided**: explicit decisions only — "we will do X by Y".
     If no decision was made, write "no decision, deferred to <when>"
   - **Open questions**: things raised but unresolved
5. **Extract action items.** Every "I'll do X" or "Can you handle Y?"
   becomes a bullet with: owner, action, deadline. If the deadline is
   vague ("soon", "next week"), pick a concrete date and flag it for
   confirmation. Action items live in their own section, not buried
   in discussion notes.
6. **Surface follow-ups.** Items that need a separate meeting or a
   ping to someone outside the room — call these out so they don't
   evaporate.
7. **Output structure:**
   ```
   # Meeting: <title> — <date>
   ## TL;DR
   <one sentence: what was this meeting and what came out of it>

   ## Participants
   <names>

   ## Discussion
   ### <Topic 1>
   - Discussion: ...
   - Decision: ...
   - Open: ...

   ## Action items
   - [ ] <Owner> — <action> — by <date>

   ## Open questions
   - <question>

   ## Follow-ups
   - Schedule <X> with <person>
   ```

## Tone for the summary

- Past tense for discussion ("we discussed...").
- Imperative for action items ("Send draft to legal by Friday").
- Neutral on contentious topics — if two people disagreed, note both
  positions, don't side with either.

## Anti-patterns to avoid

- Don't write a play-by-play. Nobody re-reads "And then Alice said...".
- Don't bury action items in discussion text — they need their own list.
- Don't invent deadlines. If unclear, flag for confirmation.
- Don't preserve every aside. Cut tangents that don't lead anywhere.

## Example invocations

> User: pastes a 4000-word transcript of a 45-minute product sync

Response: identify 4 topic clusters (roadmap, hiring, bug triage,
launch date), extract 6 decisions, 8 action items with owners,
3 open questions; deliver structured doc; flag two vague deadlines
("next week" → ask Alice to confirm Friday).

> User: "Clean up these notes from our investor pitch debrief"
> (pastes scrappy 600-word bullet dump)

Response: ask who was in the room (founder, two cofounders, advisor),
extract 3 topics (pitch feedback, follow-up commitments, next round
strategy), surface 2 explicit decisions (drop the slide on TAM,
add customer logos slide), 5 action items (founder owns 3, advisor
1, cofounder 1) with concrete dates, 2 open questions (whether to
target seed or Series A, whether to chase the warm intro from VC
X first); flag "we should probably follow up with all of them" as
too vague — ask which 3 are highest priority.
