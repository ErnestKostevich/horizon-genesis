---
name: grammar-and-tone
description: |
  Rewrite a passage with grammar fixes and tone control — formal,
  casual, executive, plain-English, or technical. Activate when the
  user says "rewrite this", "make this more formal", "make this
  shorter", "fix the grammar", "executive summary version", "explain
  like I'm five", or pastes prose for cleanup.
license: BUSL-1.1
metadata:
  category: writing
  version: 1.0.0
  author: Horizon AI
---

# Grammar and tone rewriter

Tone is not a synonym for word choice — it's a bundle of length,
formality, hedging, and rhythm. Pick a preset, then rewrite the whole
passage consistently in that voice.

## Procedure

1. **Confirm the target tone.** Ask if the user hasn't specified:
   - **Formal**: third person preferred, no contractions, hedged
     claims, longer sentences. ("It is recommended that…")
   - **Casual**: contractions, "you" address, short sentences,
     occasional fragments for emphasis.
   - **Executive**: claims-first, ≤4 sentences per paragraph, every
     sentence load-bearing. Numbers up front.
   - **Plain English**: target a 6th-grade reading level. Short
     sentences. No jargon — define or replace any term a non-expert
     wouldn't recognize.
   - **Technical**: precise vocabulary, comfortable with jargon
     appropriate to the field, code/equations inline.
2. **Fix grammar first.** Subject-verb agreement, comma splices,
   dangling modifiers, tense consistency, apostrophes, "their/there/
   they're", "its/it's". This is a baseline — independent of tone.
3. **Rewrite for tone.** Don't just swap a few words. Reshape:
   - **Formal → casual**: contract verbs, drop hedges ("It is
     possible that → maybe"), shorten sentences.
   - **Casual → formal**: expand contractions, replace "I/we" with
     passive or third person where appropriate, add hedges.
   - **Anything → executive**: lead with the conclusion. Move the
     headline number into sentence 1.
   - **Anything → plain English**: cap sentence length at ~18 words.
     Replace Latinate verbs ("utilize → use", "facilitate → help").
4. **Preserve meaning.** If the original says "we will probably ship
   by Friday", the rewrite must keep the uncertainty. Don't promote
   "probably" to "will" just because executive tone is shorter.
5. **Show a diff.** Output the rewritten version followed by 2-3
   bullet points naming the main changes (e.g., "Cut 35% of words.
   Replaced 4 instances of passive voice. Added the 30% metric to
   the opening sentence.").

## Length targets per tone

| Tone           | Avg sentence | Avg paragraph |
| -------------- | ------------ | ------------- |
| Formal         | 22-28 words  | 4-6 sentences |
| Casual         | 12-18 words  | 2-4 sentences |
| Executive      | 14-20 words  | 1-3 sentences |
| Plain English  | 10-16 words  | 2-3 sentences |
| Technical      | 18-26 words  | 3-5 sentences |

## Anti-patterns to avoid

- Don't change facts during a tone rewrite — that's editing, not rewriting.
- Don't mix tones in one passage.
- Don't add filler ("In today's fast-paced world…") to hit a length target.

## Example invocation

> User: "Rewrite this email more casually" (pastes formal email)

Response: rewrite in casual tone, output the new email + 3 bullets
naming the major changes (contractions added, two passive phrases
flipped to active, opening softened).
