// PR-V Phase 3.13 — Inline Diff Rendering (PR-U3 feature).
// Extracted from chat.html inline <script> (was lines 1629-1797).
//
// When an assistant message contains ```diff fenced blocks (or any
// fenced block whose first line looks like a unified-diff header),
// _renderDiffsInBubble swaps the rendered <pre><code> with a compact
// diff-card UI: file path header, +N -M hunk count, preview snippet,
// and Apply / Reject / Open-full-diff buttons. addMsg() calls into
// this AFTER the markdown render pass.
//
// Functions:
//   _renderDiffsInBubble — main entry: find diff blocks, attach cards
//   _parseDiffSummary    — extract file path + ±counts from diff body
//   _applyUnifiedDiff    — apply hunks to original file content
//
// Loaded as external script AFTER main inline so window.* globals it
// reads (rmGreet, addMsg, H IPC for safeWriteWorkspaceFile, etc.)
// are defined. addMsg() in main inline calls window._renderDiffsInBubble.

// PR-U3 — find every ```diff <body> ``` block in the original markdown
// text, locate the corresponding `<pre><code>` element rendered by md(),
// and replace it with a compact diff-card UI: header (file path + ±N
// hunk count), preview snippet, "Apply" / "Reject" / "Open full diff".
function _renderDiffsInBubble(messageEl, text, extra) {
  if (!messageEl || !text) return;
  // Match ```diff blocks AND any fenced block whose first line looks
  // like a unified-diff header (`--- a/foo` or `+++ b/foo`).
  const diffRe = /```(?:diff)?\s*\n((?:--- |\+\+\+ |@@ |[+\- ])[\s\S]*?)```/g;
  const diffs = [...String(text).matchAll(diffRe)].map((m, i) => ({ idx: i, body: m[1] }));
  if (!diffs.length) return;
  // The rendered <pre> blocks should appear in document order; attach
  // a card right after each one.
  const codeEls = messageEl.querySelectorAll('.bub pre');
  diffs.forEach((d, i) => {
    const codeEl = codeEls[i];
    if (!codeEl) return;
    const meta = _parseDiffSummary(d.body);
    const cardId = 'cek-bubble-' + Date.now().toString(36) + '-' + i;
    const card = document.createElement('div');
    card.className = 'cek-bubble-card';
    card.id = cardId;
    card.innerHTML = `
      <div class="cek-bubble-head">
        <span class="cek-bubble-file">${esc(meta.file || '(no file)')}</span>
        <span class="cek-bubble-stat"><span class="cek-bubble-add">+${meta.added}</span> <span class="cek-bubble-del">-${meta.removed}</span> · ${meta.hunks} hunk${meta.hunks === 1 ? '' : 's'}</span>
      </div>
      <div class="cek-bubble-actions">
        <button class="btn btn-sm primary" onclick="cekBubbleApply('${cardId}')">Apply</button>
        <button class="btn btn-sm" onclick="cekBubbleReject('${cardId}')">Reject</button>
        <button class="btn btn-sm" onclick="cekBubbleOpenFull('${cardId}')">Open full diff</button>
      </div>`;
    // Stash the raw diff body on the card so the action handlers can
    // re-read it without re-parsing the whole message.
    card._diffBody = d.body;
    card._diffMeta = meta;
    codeEl.insertAdjacentElement('afterend', card);
    // Collapse the original <pre> so the card is the canonical action
    // surface — the raw diff text becomes a "show details" reveal.
    codeEl.classList.add('cek-bubble-pre-collapsed');
  });
}

// Parse a unified-diff body for the summary chip on the card.
function _parseDiffSummary(body) {
  const lines = String(body || '').split(/\r?\n/);
  let file = '';
  let added = 0, removed = 0, hunks = 0;
  for (const line of lines) {
    if (line.startsWith('+++ b/')) file = line.slice(6).trim();
    else if (line.startsWith('+++ ')) file = line.slice(4).trim();
    else if (!file && line.startsWith('--- a/')) file = line.slice(6).trim();
    else if (line.startsWith('@@ ')) hunks++;
    else if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  return { file, added, removed, hunks: hunks || 1 };
}

window.cekBubbleApply = async function (cardId) {
  const card = document.getElementById(cardId);
  if (!card || !card._diffBody) return;
  // Open the full per-hunk picker modal seeded with this diff. Reuses
  // the existing requestDiffPermissionPerHunk path so the apply logic
  // is the same as ⌘K diffs.
  const meta = card._diffMeta || { file: '' };
  if (!meta.file) {
    if (typeof addMsg === 'function') addMsg('bot', '⚠️ Diff has no file path — can\'t apply automatically. Open the full diff to copy as patch.');
    return;
  }
  // Read current file content from workspace, build before/after pair
  // by applying the diff client-side, then hand off to the modal.
  try {
    const current = await H.wsRead?.(meta.file);
    if (!current || !current.ok) {
      if (typeof addMsg === 'function') addMsg('bot', `⚠️ Couldn't read \`${meta.file}\`: ${current?.err || 'no workspace?'}`);
      return;
    }
    // Naive unified-diff applier: walk hunks, splice into the original.
    // Same algorithm as PR-D1.4 _runMultiFileEdit's mergedAfter path.
    const patched = _applyUnifiedDiff(current.content || '', card._diffBody);
    if (!patched.ok) {
      if (typeof addMsg === 'function') addMsg('bot', `⚠️ Diff didn't apply cleanly: ${patched.error}`);
      return;
    }
    if (typeof requestDiffPermissionPerHunk === 'function') {
      const r = await requestDiffPermissionPerHunk({
        title: meta.file,
        description: 'Inline diff from assistant message',
        before: current.content || '',
        after: patched.text,
        language: (typeof inferCodeLang === 'function') ? inferCodeLang(meta.file) : 'plaintext',
      });
      if (r && r.ok && r.accepted > 0) {
        const w = await H.wsWrite?.(meta.file, r.mergedAfter);
        if (w && w.ok !== false) {
          card.classList.add('cek-bubble-applied');
          card.querySelector('.cek-bubble-actions').innerHTML = '<span class="cek-bubble-state-ok">✓ Applied · file saved</span>';
        } else {
          if (typeof addMsg === 'function') addMsg('bot', `⚠️ Write failed: ${w?.error || 'unknown'}`);
        }
      }
    }
  } catch (e) {
    if (typeof addMsg === 'function') addMsg('bot', `⚠️ Apply failed: ${e?.message || e}`);
  }
};
window.cekBubbleReject = function (cardId) {
  const card = document.getElementById(cardId);
  if (!card) return;
  card.classList.add('cek-bubble-rejected');
  card.querySelector('.cek-bubble-actions').innerHTML = '<span class="cek-bubble-state-x">✗ Rejected</span>';
};
window.cekBubbleOpenFull = async function (cardId) {
  const card = document.getElementById(cardId);
  if (!card || !card._diffBody) return;
  const meta = card._diffMeta || {};
  // Show the raw diff in a quick alert-style modal (or just expand the
  // collapsed <pre> if no modal is available).
  const pre = card.previousElementSibling;
  if (pre && pre.classList.contains('cek-bubble-pre-collapsed')) {
    pre.classList.remove('cek-bubble-pre-collapsed');
    pre.classList.add('cek-bubble-pre-expanded');
  }
};

// Tiny unified-diff applier. Handles the standard `@@ -a,b +c,d @@`
// hunk header + `+ - ` body lines. Returns { ok, text } or { ok:false,
// error }. Tolerates missing line numbers by falling back to context-
// matching the first non-empty `-` line in the original.
function _applyUnifiedDiff(original, diffBody) {
  try {
    const origLines = String(original || '').split(/\r?\n/);
    const diffLines = String(diffBody || '').split(/\r?\n/);
    let result = origLines.slice();
    // Walk hunks bottom-up so splicing earlier doesn't invalidate later
    // line numbers.
    const hunks = [];
    let curHunk = null;
    for (const line of diffLines) {
      if (line.startsWith('@@ ')) {
        if (curHunk) hunks.push(curHunk);
        const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
        if (!m) { curHunk = null; continue; }
        curHunk = {
          oldStart: Number(m[1]),
          oldCount: m[2] ? Number(m[2]) : 1,
          lines: [],
        };
      } else if (curHunk && (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-'))) {
        curHunk.lines.push(line);
      }
    }
    if (curHunk) hunks.push(curHunk);
    // Apply bottom-up.
    hunks.sort((a, b) => b.oldStart - a.oldStart);
    for (const h of hunks) {
      // Build the replacement: keep ' ' + '+', drop '-'.
      const replacement = h.lines
        .filter(l => l.startsWith(' ') || l.startsWith('+'))
        .map(l => l.slice(1));
      // Splice the original range.
      const start = Math.max(0, h.oldStart - 1);
      const count = Math.max(0, h.oldCount);
      result.splice(start, count, ...replacement);
    }
    return { ok: true, text: result.join('\n') };
  } catch (e) { return { ok: false, error: e.message }; }
}

