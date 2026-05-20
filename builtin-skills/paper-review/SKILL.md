---
name: paper-review
description: |
  Read an academic paper end-to-end and produce a structured summary with
  critique covering claims, methodology, results, and limitations. Activate
  when the user shares an arXiv link, PDF of a paper, or says "review this
  paper", "what does this paper actually show", "critique this study",
  "is this paper any good".
license: BUSL-1.1
metadata:
  category: research
  version: 1.0.0
  author: Horizon AI
---

# Paper review

Papers are not summaries of themselves. The abstract sells, the methods
section tells. A real review reads the methods, checks if the results
support the headline claim, and names the limitations the authors
underplayed. Use `web_extract` for arXiv links, `read_file` for PDFs.

## Procedure

1. **Fetch the full paper.** Don't review from an abstract. Get the
   PDF or HTML. Note the venue (arXiv preprint, peer-reviewed conference,
   journal) — peer review status matters for confidence.
2. **Read in this order:** abstract → introduction → methods → results
   → discussion → limitations → references → back to results to verify
   they match the headline. Skipping methods is the most common
   review failure.
3. **Extract the headline claim.** What does the paper say it found,
   in one sentence? This is what the press will quote. Write it verbatim
   if possible.
4. **Check the methodology.** Ask of every paper:
   - **Sample**: how big, how selected, representative of what population?
   - **Comparison**: what's the baseline or control?
   - **Measurement**: how were outcomes defined and measured?
   - **Statistics**: appropriate tests? Multiple comparison correction?
     Effect sizes, not just p-values?
   - **Reproducibility**: code/data available? Pre-registered?
5. **Verify results support claims.** Read the actual numbers in tables
   and figures. Does the headline number appear there? Is it the
   primary outcome or a sub-analysis? Note any p-hacking smells (only
   one comparison reported significant, suspicious subgroup splits).
6. **Surface limitations.** Every paper has them. Authors usually bury
   one paragraph of caveats at the end. Pull them out and add any
   they didn't mention.
7. **Output structure:**
   ```
   ## Citation
   Authors, Year, Title — venue/URL

   ## Headline claim
   <one sentence>

   ## What they did
   <3-5 bullets on methodology>

   ## What they found
   <3-5 bullets on actual results with numbers>

   ## Strengths
   <2-3 bullets>

   ## Limitations
   <3-5 bullets, including any the authors downplayed>

   ## Should you trust it?
   <1-2 sentences calibrated by sample size, peer review, replication>
   ```

## Anti-patterns to avoid

- Don't take the abstract's confident framing at face value.
- Don't review a paper without checking the methods section.
- Don't conflate "statistically significant" with "important".
- Don't ignore funding sources or competing interests.
- Don't critique math you haven't read — say "I didn't verify the
  proofs" if you didn't.

## Example invocations

> User: "Review this paper: arxiv.org/abs/2305.10403"

Response: fetch the PDF, read methods (RLHF on 70B model, n=200
human raters), verify the 25% preference number appears in Table 3,
output structured review noting the strong methodology but small
rater pool and lack of open data, conclude "trust the direction but
not the magnitude until replicated".

> User: "Is this paper any good? <link to a nutrition study claiming
> ketogenic diet reverses diabetes>"

Response: fetch full text; note it's a single-arm observational study,
n=87, no control group, 12-month follow-up with 31% dropout. Headline
claim "60% reverse diabetes" appears in Table 2 but defined as HbA1c
< 6.5% (less strict than ADA "remission"). Strengths: real-world
measurement, decent retention given the diet. Limitations: no control
arm, self-selected motivated participants, single-clinic recruitment,
funded by a low-carb advocacy group. Verdict: "interesting signal,
not strong enough to act on — needs an RCT with comparable
calorie-restricted control."
