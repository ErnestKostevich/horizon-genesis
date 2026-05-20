---
name: blog-post
description: |
  Draft a blog post from a topic or rough notes through outline → first
  draft → polish pipeline, with tone control (technical, conversational,
  thought-leadership, tutorial). Activate when the user says "write a
  blog post", "blog about X", "draft an article", "write something for
  the company blog", "tutorial on Y".
license: BUSL-1.1
metadata:
  category: writing
  version: 1.0.0
  author: Horizon AI
---

# Blog post pipeline

A good blog post is built, not typed in one go. The pipeline below
produces drafts that read like they were written by a human who knew
the topic — not a model that scraped Wikipedia.

## Procedure

1. **Gather inputs.** Ask the user for:
   - The topic (or paste their rough notes).
   - The audience (engineers? PMs? recruiters? general readers?).
   - The desired tone: technical, conversational, thought-leadership,
     tutorial, or postmortem.
   - The target length (default 800-1200 words).
   - One concrete outcome the reader should walk away with.
   If anything is missing, ask before drafting. Don't guess the tone.
2. **Outline first.** Produce a numbered outline with H2 headings and
   one-line summaries under each. Show this to the user and wait for
   feedback before drafting prose. Most blog posts that fail were
   never going to work at the outline stage.
3. **Draft the lede.** The first 2-3 sentences must hook a skimmer.
   Tactics that work: a concrete number, a counterintuitive claim, a
   short scene. Tactics that don't: "In today's fast-paced world…",
   "Have you ever wondered…", definitions.
4. **Draft the body.** One idea per section. Each section should answer
   "so what?". Include at least one concrete example, code block, or
   data point per section. Cut filler ruthlessly — "it is important to
   note that" → delete.
5. **Draft the close.** Re-state the takeaway in one sentence. Offer
   one next action the reader can take. Avoid "in conclusion".
6. **Polish pass.** Read the draft top-to-bottom and:
   - Cut any sentence that doesn't earn its place.
   - Replace passive voice with active where it reads better.
   - Vary sentence length — clusters of similar-length sentences
     feel robotic.
   - Check tone consistency against step 1.
   - Add a title (≤60 chars, no clickbait, includes the keyword).
7. **Output** the title, a 1-sentence meta description (≤155 chars
   for SEO), the body in Markdown, and an estimated read time
   (200 words/minute).

## Tone presets

- **Technical**: precise, code-heavy, comfortable with jargon, terse.
- **Conversational**: contractions ok, "you" address, occasional humor.
- **Thought-leadership**: claims-first, opinionated, takes a position.
- **Tutorial**: imperative voice ("Run this", "Open that"), step-numbered.
- **Postmortem**: timeline, root cause, what we changed, no blame.

## Anti-patterns to avoid

- Don't write 5 paragraphs of context before the point.
- Don't use lists where prose would be tighter.
- Don't end with "What do you think? Let me know in the comments!".

## Example invocation

> User: "Write a blog post about why we moved from REST to GraphQL"

Response: ask about audience, tone, key wins to highlight; outline with
sections ("the breaking point", "the migration", "what we'd do
differently"); confirm outline; draft; polish; deliver.
