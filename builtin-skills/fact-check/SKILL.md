---
name: fact-check
description: |
  Verify claims against primary sources, label each as supported,
  contradicted, unverified, or misleading. Activate when the user says
  "fact-check this", "is this true", "verify this claim", "check this
  article", "did X actually say Y", or pastes text containing factual
  assertions that need independent confirmation.
license: BUSL-1.1
metadata:
  category: research
  version: 1.0.0
  author: Horizon AI
---

# Fact-check

A claim is fact-checkable only if it's specific. "AI is dangerous" is an
opinion; "GPT-4 was trained on 13 trillion tokens" is checkable. Pull
out the specific claims, then verify each against the strongest source
you can find. Use `web_search` and `web_extract` for sources.

## Procedure

1. **Extract the claims.** Read the input and list every checkable
   factual assertion. Number them. Skip pure opinion and undefined
   superlatives ("the best", "everyone knows"). Aim for 3-10 claims
   per pass — longer lists lose accuracy.
2. **Classify each claim by type.**
   - **Numeric** ("X grew by 40%") → find the underlying data source
   - **Quote** ("X said Y") → find the original transcript/recording
   - **Causal** ("A caused B") → look for studies, not just correlation
   - **Existence** ("Company X has feature Y") → check the product itself
   - **Historical** ("Happened on date X") → check archival sources
3. **Find primary sources.** For each claim, search for the original.
   Quotes need transcripts or video, not news reports of the quote.
   Numbers need the study or filing, not a press release. If only
   secondary sources exist, note that.
4. **Verdict per claim.** Pick exactly one label:
   - **Supported**: primary source confirms the claim as stated
   - **Contradicted**: primary source says something different
   - **Misleading**: technically true but stripped of context
     (e.g., a real quote used to mean the opposite)
   - **Unverified**: couldn't find a primary source either way
   - **Unfalsifiable**: not a checkable claim (opinion, prediction)
5. **Quote the evidence.** For each verdict, include a one-sentence
   quote from the source plus a URL. The user must be able to click
   and verify in 30 seconds.
6. **Output structure:**
   ```
   ## Claim 1: <restated>
   Verdict: Supported
   Evidence: "<quote>" — Source URL (date)

   ## Claim 2: ...
   ```
7. **Summary line.** End with "X supported, Y contradicted, Z misleading,
   W unverified" so the user sees the overall reliability at a glance.

## Anti-patterns to avoid

- Don't fact-check opinions or predictions. Mark them unfalsifiable
  and move on.
- Don't rely on the article being fact-checked as its own source.
- Don't say "true" or "false" — use the five labels above.
- Don't strip context yourself when quoting. If the source has
  caveats, include them.

## Example invocations

> User: "Fact-check this tweet: 'Stripe processes 80% of all online
> payments in the US, founded by two Irish brothers in 2010'"

Response: extract 3 claims (market share, founding year, founders),
search Stripe's S-1/press, output:
- Claim 1 (80% market share): Contradicted — Stripe's filing says
  significantly less.
- Claim 2 (founded 2010): Supported.
- Claim 3 (Irish brothers): Supported. Patrick and John Collison.

> User: "Fact-check this paragraph from an article about EV adoption"
> (pastes 4 sentences with 5 numeric claims)

Response: extract 5 claims (charging stations count, sales growth %,
range-anxiety survey number, battery cost projection, government
target). Verdicts: 2 supported (charging stations, sales growth via
IEA report), 1 misleading (survey number is real but from 2019 and
the field has changed), 1 contradicted (battery cost cited as $80/kWh
but BloombergNEF latest is $115), 1 unverified (government target —
couldn't locate primary policy doc). Summary: 2 supported, 1
contradicted, 1 misleading, 1 unverified — moderate reliability.
