---
name: web-research
description: |
  Multi-source web research with citations — search broadly, read deeply,
  synthesize findings with provenance. Activate when the user says "research
  X", "find sources on", "dig into this topic", "what's the current state
  of", "give me background on", or asks a factual question that needs more
  than one source to answer reliably.
license: BUSL-1.1
metadata:
  category: research
  version: 1.0.0
  author: Horizon AI
---

# Web research

Good research is not "Google it and paste the first result". It's three
queries minimum, cross-checked against each other, with the user seeing
where each claim came from. Use `web_search` to find candidates,
`web_extract` to pull full text, and quote sources by URL.

## Procedure

1. **Clarify the question.** Restate the user's question in one sentence
   and confirm scope before searching. "Research GraphQL" is too broad —
   ask whether they want adoption stats, vs-REST tradeoffs, security
   pitfalls, or migration guides.
2. **Plan the queries.** Write 3-5 distinct search queries that approach
   the question from different angles: definition, current state,
   criticism, recent news, primary sources. Show the plan before running.
3. **Run searches and triage results.** For each query, scan the top 10
   hits. Skip SEO farms, listicles, and pages older than 2 years unless
   the topic is historical. Prefer: primary sources, official docs,
   peer-reviewed papers, well-known engineering blogs, government
   statistics.
4. **Read, don't skim.** Use `web_extract` on the 5-8 most promising
   results. Read each fully. Note the publication date, author, and any
   conflict of interest (vendor pushing their own product, lobbying group).
5. **Synthesize with citations.** Write a 200-400 word synthesis. Every
   factual claim gets an inline citation `[1]` linking to a numbered
   sources list at the bottom. If two sources disagree, name the
   disagreement and quote both.
6. **Flag uncertainty.** Add a "Confidence" line: high (multiple
   independent primary sources agree), medium (one strong source,
   others derivative), low (anecdotal or single-source). Don't hide
   weak evidence behind confident prose.
7. **Output structure:**
   ```
   ## Question
   <restated>

   ## Findings
   <synthesis with [1][2] citations>

   ## Confidence
   <high/medium/low + one-line why>

   ## Sources
   [1] Title — URL (published date)
   [2] ...
   ```

## Anti-patterns to avoid

- Don't cite Wikipedia as a primary source — follow its references.
- Don't use a single source for a factual claim.
- Don't paraphrase without citing — that's plagiarism with extra steps.
- Don't trust dates in URLs — verify the published date in the page.

## Example invocations

> User: "Research how Postgres handles JSON vs JSONB"

Response: confirm scope (performance? indexing? when to use which?),
run 4 queries (Postgres docs, perf benchmarks, schema design posts,
recent changes), extract from 6 pages, output 300-word synthesis
with 6 citations, confidence "high" because Postgres docs + 3
independent benchmarks agree.

> User: "Give me background on the EU AI Act and its impact on
> open-source models"

Response: clarify focus (legal text vs industry reactions vs
specific open-source impact); run 5 queries hitting the official
EUR-Lex text, two policy think-tank analyses, the AI community's
response, and recent enforcement news; extract from 8 sources;
output a synthesis noting open-source carve-outs in Article 2,
quote both supporters and critics, mark confidence "medium" because
enforcement specifics still evolving.
