---
name: summarize-anything
description: |
  Summarize a URL, PDF, audio file, YouTube video, or long document into
  bulleted takeaways with a TL;DR header. Activate when the user shares
  a link, paper, transcript, recording, or says "summarize this",
  "tl;dr", "give me the gist", "what's this about", "key points from X".
license: BUSL-1.1
metadata:
  category: writing
  version: 1.0.0
  author: Horizon AI
---

# Summarize anything

A summary should be readable in a quarter of the time the source takes.
The structure below holds up for articles, papers, talks, podcasts,
and meeting transcripts alike. Use `web_extract` for URLs,
`read_file` for local files.

## Procedure

1. **Identify the source type.** Different sources need different
   handling:
   - URL → use `web_extract` to fetch the rendered text
   - PDF → use `read_file` (or pdftotext if needed)
   - YouTube → fetch the transcript via the URL
   - Audio → ask if a transcript exists; if not, request one
   - Pasted text → use as-is
2. **Read fully before summarizing.** Don't summarize from the title
   or abstract alone. For papers, read the methods section, not just
   conclusions. For talks, watch the Q&A — that's where the real
   takes live.
3. **Identify the through-line.** What is the single most important
   claim or finding? Write it as one sentence — this is the TL;DR.
4. **Extract supporting points.** Pick 3-7 bullets. Each must:
   - State a fact or claim (not a topic).
   - Be specific — numbers, names, concrete examples.
   - Stand alone — readable without the surrounding context.
5. **Flag what's missing.** If the source has notable omissions
   (no methodology, no counterargument, undisclosed conflicts of
   interest, anecdotes-as-evidence), add a "Caveats" line.
6. **Output structure:**
   ```
   ## TL;DR
   <one sentence>

   ## Key points
   - <fact 1>
   - <fact 2>
   - …

   ## Caveats
   <one line, only if applicable>

   ## Source
   <link or filename>
   ```
7. **Calibrate length** to source length:
   - <2,000 words source → TL;DR + 3 bullets
   - 2,000-10,000 words → TL;DR + 5-7 bullets
   - >10,000 words or 1+ hour video → TL;DR + 7 bullets + section-by-section

## Anti-patterns to avoid

- Don't paraphrase paragraph by paragraph — that's a compression,
  not a summary.
- Don't lose the headline number. If the article says "37% faster",
  the summary must include "37% faster".
- Don't editorialize. Mark opinions as the source author's, not yours.
- Don't summarize without reading — abstracts mislead.

## Example invocation

> User: "Summarize this paper" (pastes a 30-page arXiv PDF link)

Response: fetch the PDF, read it, output:
```
## TL;DR
Speculative decoding with a 7B draft model can speed up 70B inference
by 2.3x on average without quality loss.

## Key points
- Draft model accepts 78% of speculated tokens
- Throughput: 142 tok/s vs 61 tok/s baseline on A100
- ...
```
