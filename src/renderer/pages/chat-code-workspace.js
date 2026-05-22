// PR-V Phase 3.14 — Code Mode IDE workspace (BIG extraction).
// Extracted from chat.html inline <script> (was lines 4938-7354).
// ~2418 LOC — the single biggest module extracted so far.
//
// Cursor-style code workspace: Monaco editor + xterm.js terminal +
// file tree + AI edit (⌘K) + per-file tab persistence + diff apply
// with permission gate + Git auto-commit + Quick Open file picker.
//
// Bundled because everything in this module reads/writes the same
// core state (codeEditor, codeTerminal, codeWorkspace, codeDir,
// codeCurrentFile, codeOpenFiles, codeActiveTabIdx, codeTreeNodes).
// Extracting subsets would require cross-file state coupling that's
// uglier than just keeping the IDE as one module.
//
// NOTE: top of file also contains OPERATOR state vars (operatorRuns,
// operatorLogLines, operatorPaused, etc.) that were physically
// adjacent in the original inline code (under shared header
// '// CODE MODE / OPERATOR MODE RUNTIME'). The operator FUNCTIONS
// remain inline in chat.html and access these vars via window.* —
// works because top-level var declarations bind to window.
//
// Sections:
//   - Code + Operator state vars (codeModeActive, codeWorkspace,
//     operatorRuns, operatorLogLines, etc.)
//   - initCodeEditor + _setupCodeEditorBindings (Monaco setup)
//   - CEK ⌘K bar: openCmdKBar, closeCmdKBar, parseCodeEditReply,
//     _ensureWithinWorkspace, codeGetValue/SetValue, selection
//     snapshots, extractCodeFence
//   - Workspace terminal: initWorkspaceTerminal, restartWorkspaceTerminal,
//     appendTerminalFallback
//   - CEK history + auto-commit: cekRefreshToolbar, cekRecordHistory,
//     cekUndoEntry, cekMaybeAutoCommit
//   - Workspace helpers: codeJoin, codeRelJoin, codeSetStatus,
//     inferCodeLang, renderCodeContext
//   - Surface toggles: toggleCodeTerminal, toggleCodeChat
//   - Workspace ops: chooseCodeWorkspace, refreshCodeWorkspace,
//     searchCodeWorkspace, file tree state (codeTreeNodes, codeTreeIgnore,
//     renderCodeTree)
//   - File tabs: codeOpenFiles, codeActiveTabIdx, openCodeFile,
//     closeCodeTab, renderCodeTabs, _persistOpenTabs, saveCodeFile
//   - askCodeAi (Apply / Refactor / Explain / Fix AI prompts)
//   - toggleCodeMode (surface enter/exit)
//   - QuickOpen file picker (Ctrl+P): openQuickOpen, closeQuickOpen,
//     filterQuickOpen, quickOpenKeyDown, _updateQOSelection,
//     quickOpenSelect, _qoSelected/Timer/LastQuery state

// CODE MODE / OPERATOR MODE RUNTIME
var codeModeActive = false;
var codeWorkspace = '';
var codeDir = '';
var codeCurrentFile = '';
var operatorRuns = new Map();
var operatorLogLines = [];
var operatorTab = 'log';
var operatorPaused = false;
var operatorStopRequested = false;
var operatorCurrentAgentRunId = '';
var operatorWaitingStepId = '';
var operatorRunHistory = [];
var operatorRunJson = null;
var operatorAgentListenerInstalled = false;
var activeAgentPanelSteps = null;
var activeAgentPanelRef = null;
var opSeq = 0;
var activeMessageRun = null;
var codeEditor = null;
var codeEditorReady = null;
var codeLastAiPatch = null;
var codeTerminal = null;
var codeTerminalId = '';
var opLogPersistTimer = null;
var operatorLogChatId = null;

function opLogStorageKey(id) {
  id = id || ((typeof currentChatId !== 'undefined' && currentChatId) ? currentChatId : 'scratch');
  return `horizon.operatorLog.${id}`;
}

async function opEnsureChatIdForLog() {
  if (typeof currentChatId !== 'undefined' && currentChatId) return currentChatId;
  if (typeof _ensureCurrentChatIdForPersist === 'function') {
    return await _ensureCurrentChatIdForPersist();
  }
  try {
    const cur = await window.H?.chatGetCurrent?.();
    if (cur && cur.id && typeof currentChatId !== 'undefined') currentChatId = cur.id;
    return cur?.id || null;
  } catch (_) {
    return null;
  }
}

async function opPersistLogRows(chatId, rows) {
  try {
    const trimmed = (Array.isArray(rows) ? rows : []).slice(-300);
    const id = chatId || await opEnsureChatIdForLog();
    if (id && window.H?.chatSetLogs) {
      await window.H.chatSetLogs(id, trimmed);
    }
    // Keep a localStorage mirror only as an emergency migration fallback.
    try { localStorage.setItem(opLogStorageKey(id), JSON.stringify(trimmed)); } catch (_) {}
  } catch (_) {}
}

async function opPersistLogForCurrentChat(chatId) {
  const target = chatId || operatorLogChatId || ((typeof currentChatId !== 'undefined' && currentChatId) ? currentChatId : null);
  return opPersistLogRows(target, operatorLogLines || []);
}

function opSchedulePersistLogForCurrentChat() {
  if (opLogPersistTimer) clearTimeout(opLogPersistTimer);
  const target = operatorLogChatId || ((typeof currentChatId !== 'undefined' && currentChatId) ? currentChatId : null);
  const rows = (operatorLogLines || []).slice(-300);
  opLogPersistTimer = setTimeout(() => {
    opLogPersistTimer = null;
    opPersistLogRows(target, rows).catch(() => {});
  }, 160);
}

async function loadOperatorLogForCurrentChat(chatId) {
  try {
    const id = chatId || await opEnsureChatIdForLog();
    operatorLogChatId = id || null;
    let rows = [];
    if (id && window.H?.chatGetLogs) {
      const res = await window.H.chatGetLogs(id);
      if (Array.isArray(res?.logs)) rows = res.logs;
    }
    if (!rows.length) {
      const raw = localStorage.getItem(opLogStorageKey(id));
      rows = raw ? JSON.parse(raw) : [];
      if (Array.isArray(rows) && rows.length && id && window.H?.chatSetLogs) {
        window.H.chatSetLogs(id, rows.slice(-300)).catch(() => {});
      }
    }
    operatorLogLines = Array.isArray(rows) ? rows.slice(-300) : [];
  } catch (_) {
    operatorLogLines = [];
  }
  try { opRender(); } catch (_) {}
  try { if (inspectorTab === 'log') refreshInspectorLog(); } catch (_) {}
}
var codeTerminalListenerInstalled = false;
var codeTerminalResizeInstalled = false;

function initCodeEditor(){
  if(codeEditorReady) return codeEditorReady;
  codeEditorReady = new Promise(resolve => {
    const fallback = () => {
      const ta = document.getElementById('code-editor');
      const host = document.getElementById('code-monaco');
      if(host) host.style.display = 'none';
      if(ta) ta.style.display = 'block';
      resolve(false);
    };
    try {
      if (typeof window.require !== 'function') return fallback();
      // If Monaco's editor.main is already on window (someone else loaded
      // it earlier), reuse it instead of re-defining the AMD module — the
      // "Duplicate definition of module 'vs/editor/editor.main'" warning in
      // the console comes from a second require([...]) call after the
      // first one completed. Once monaco.editor exists we can skip the
      // require entirely.
      if (window.monaco && window.monaco.editor) {
        const host = document.getElementById('code-monaco');
        const ta = document.getElementById('code-editor');
        if (!host) return fallback();
        if (ta) ta.style.display = 'none';
        codeEditor = monaco.editor.create(host, {
          value: ta?.value || '',
          language: 'javascript',
          theme: 'vs-dark',
          minimap: { enabled: false },
          fontSize: 12,
          lineNumbers: 'on',
          scrollBeyondLastLine: false,
          automaticLayout: true,
          wordWrap: 'on',
        });
        _setupCodeEditorBindings(ta);
        resolve(true);
        return;
      }
      // Configure once. `require.config` is idempotent for the `paths`
      // field but the Monaco loader internally re-runs its module
      // initialisation if called repeatedly — which is the trigger for the
      // `Duplicate definition of module 'vs/editor/editor.main'` warning
      // visible in DevTools. Gate behind a flag and pass
      // `ignoreDuplicateModules` so that even if a downstream caller
      // bypasses the gate, the warning is suppressed. (The loader's
      // `isDuplicateMessageIgnoredFor` check is a first-class config; see
      // node_modules/monaco-editor/min/vs/loader.js lines 204-260.)
      if (!window.__monacoConfigured) {
        window.require.config({
          paths: { vs: '/vendor/monaco' },
          ignoreDuplicateModules: ['vs/editor/editor.main'],
        });
        window.__monacoConfigured = true;
      }
      window.require(['vs/editor/editor.main'], () => {
        const host = document.getElementById('code-monaco');
        const ta = document.getElementById('code-editor');
        if(!host) return fallback();
        if(ta) ta.style.display = 'none';
        codeEditor = monaco.editor.create(host, {
          value: ta?.value || '',
          language: 'javascript',
          theme: 'vs-dark',
          minimap: { enabled:false },
          fontSize: 12,
          lineNumbers: 'on',
          scrollBeyondLastLine: false,
          automaticLayout: true,
          wordWrap: 'on',
        });
        _setupCodeEditorBindings(ta);
        resolve(true);
      }, fallback);
    } catch(_) { fallback(); }
  });
  return codeEditorReady;
}

// Wire post-create listeners + keybindings + context menu actions onto the
// freshly-created `codeEditor` Monaco instance. Extracted because there are
// two creation paths in initCodeEditor() (the short-circuit when monaco is
// already on window, and the require-callback path) and the original code
// only set up listeners on the second path — meaning users who entered Code
// Mode after Monaco was preloaded silently lost dirty-state tracking, the
// Explain/Refactor/Fix context menu, and the resize handler. Now both paths
// get the same wiring, and we bolt the new ⌘K (PR-D1) prompt-bar on top.
function _setupCodeEditorBindings(ta) {
  if (!codeEditor) return;
  // Dirty-tab tracking — sync textarea fallback + flag the active tab.
  codeEditor.onDidChangeModelContent(() => {
    if (ta) ta.value = codeEditor.getValue();
    try {
      const tab = codeOpenFiles[codeActiveTabIdx];
      if (tab) {
        const nowDirty = codeEditor.getValue() !== tab.content;
        if (nowDirty !== tab.dirty) {
          tab.dirty = nowDirty;
          renderCodeTabs();
        }
      }
    } catch(_){}
  });
  // Context-menu actions for selected text.
  for (const [id, label, kind] of [
    ['horizonExplainSelection', 'Horizon: Explain Selection', 'explain'],
    ['horizonRefactorSelection', 'Horizon: Refactor Selection', 'refactor'],
    ['horizonFixSelection', 'Horizon: Fix Selection', 'fix'],
  ]) {
    codeEditor.addAction({
      id,
      label,
      contextMenuGroupId: 'navigation',
      contextMenuOrder: kind === 'explain' ? 1 : kind === 'refactor' ? 2 : 3,
      run: () => askCodeAi(kind)
    });
  }
  // ⌘K / Ctrl+K → opens the floating AI edit prompt over the selection.
  // PR-D1.1 captures payload only (downstream sub-PRs wire the LLM call,
  // diff preview, and apply path). The keybinding is registered as both
  // a direct command (works inside Monaco's focus) and a global command
  // (works even when the user is focused on the textarea fallback).
  try {
    if (window.monaco && monaco.KeyMod && monaco.KeyCode) {
      codeEditor.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK,
        () => openCmdKBar()
      );
    }
  } catch(_){}
  // Resize handler — Monaco needs an explicit layout() call when its
  // container resizes (it doesn't observe the parent on its own).
  if (!_codeEditorResizeBound) {
    window.addEventListener('resize', () => { try { codeEditor.layout(); } catch(_){} });
    _codeEditorResizeBound = true;
  }
}
var _codeEditorResizeBound = false;

// ─── ⌘K floating edit bar — PR-D1.1 ─────────────────────────────────
// Open: capture the current Monaco selection, position the .cek-bar over
// (or below) it, focus the input. Esc closes; Enter logs payload (D1.2
// will wire LLM call + diff preview).
function openCmdKBar() {
  const bar = document.getElementById('cek-bar');
  const input = document.getElementById('cek-bar-input');
  const scopeEl = document.getElementById('cek-bar-scope');
  const modelEl = document.getElementById('cek-bar-model');
  if (!bar || !input || !codeEditor) return;

  const sel = codeEditor.getSelection();
  const model = codeEditor.getModel();
  if (!sel || !model) return;
  const selectedText = model.getValueInRange(sel) || '';
  const hasSelection = selectedText.length > 0;

  // Scope label + model hint for the bar's footer row.
  if (scopeEl) {
    if (hasSelection) {
      const lineCount = sel.endLineNumber - sel.startLineNumber + 1;
      scopeEl.textContent = `selection · L${sel.startLineNumber}-${sel.endLineNumber} · ${lineCount} ${lineCount === 1 ? 'line' : 'lines'}`;
    } else {
      const total = model.getLineCount();
      scopeEl.textContent = `whole file · ${total} lines`;
    }
  }
  if (modelEl) {
    try {
      const m = (typeof prov !== 'undefined' && typeof getSelectedModelForProvider === 'function')
        ? getSelectedModelForProvider(prov)
        : '';
      modelEl.textContent = m ? `model: ${m}` : 'model: —';
    } catch(_) { modelEl.textContent = 'model: —'; }
  }

  // Position: anchor below the selection's first visible line so the bar
  // doesn't cover the code being edited. Falls back to top-center of the
  // editor host if positions can't be resolved.
  try {
    const host = document.getElementById('code-monaco');
    const hostRect = host?.getBoundingClientRect();
    const lineTop = codeEditor.getTopForLineNumber(sel.startLineNumber);
    const scrollTop = codeEditor.getScrollTop();
    const yInHost = Math.max(0, lineTop - scrollTop + 22); // 22px below selection top
    bar.style.top = `${yInHost}px`;
    if (hostRect) {
      const barWidth = 480;
      const left = Math.max(12, Math.min(hostRect.width - barWidth - 12, hostRect.width / 2 - barWidth / 2));
      bar.style.left = `${left}px`;
    }
  } catch(_) {
    bar.style.top = '24px';
    bar.style.left = '50%';
    bar.style.transform = 'translateX(-50%)';
  }

  bar.classList.add('show');
  input.value = '';
  input.focus();

  // Single-shot key handler — Esc closes; Enter submits.
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeCmdKBar();
      input.removeEventListener('keydown', onKey);
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      input.removeEventListener('keydown', onKey);
      submitCmdKBar();
    }
  };
  input.addEventListener('keydown', onKey);
}

function closeCmdKBar() {
  const bar = document.getElementById('cek-bar');
  if (bar) bar.classList.remove('show');
  // Return focus to the editor so the user can keep typing.
  try { codeEditor?.focus(); } catch(_){}
}

// PR-D1.2 — real LLM round-trip + Monaco diff preview.
//
// Approach: ask the LLM for a REPLACEMENT block (not unified diff) so
// parsing stays bulletproof — we already have `extractCodeFence()` that
// pulls the last fenced code block out of any reply. The diff modal
// (`requestDiffPermission`) does its own line-by-line visualisation,
// so a unified-diff format isn't needed until D1.3 (per-hunk
// accept/reject) and D1.4 (multi-file batch).
//
// On accept we apply the replacement via Monaco's `executeEdits`, which
// fires `onDidChangeModelContent` → tab marked dirty automatically.
// Save-to-disk is a separate explicit user action (existing 💾 Save
// button) so the user can review one more time before the file changes.
//
// Cancel paths covered:
//   • Empty prompt / no editor → silent close (D1.1 behaviour preserved).
//   • LLM returned no fenced code → addMsg with the raw reply so the
//     user can see what the model said (debug visibility).
//   • User rejects diff → Monaco buffer untouched, opLog notes the
//     rejection.
// PR-D1.4 — parse a code-edit reply into per-file entries.
//
// The model can return either:
//   (a) ONE fenced code block — single-file edit. Returns
//       [{ filePath: 'current', content, language, isCurrent: true }]
//       (filePath='current' means "the file currently open in the editor").
//   (b) Multiple `===FILE: <path>===` headers each followed by a fenced
//       block — multi-file edit. Returns one entry per file.
//
// Path normalisation: backslashes → forward slashes, leading `./` stripped,
// leading `/` stripped. Workspace boundary check happens later in the
// apply path (see _applyMultiFileEdits).
function parseCodeEditReply(reply, currentFilePath, fallbackLanguage) {
  const text = String(reply || '').trim();
  if (!text) return [];
  // Multi-file format: split on `===FILE: <path>===` markers.
  const fileHdr = /^[ \t]*={3,}[ \t]*FILE:[ \t]*([^\n=]+?)[ \t]*={3,}[ \t]*$/m;
  if (fileHdr.test(text)) {
    const parts = text.split(/^[ \t]*={3,}[ \t]*FILE:[ \t]*([^\n=]+?)[ \t]*={3,}[ \t]*$/m);
    const out = [];
    // After split: parts[0] = preamble (ignored), then alternating
    //   parts[1] = path, parts[2] = body, parts[3] = path, parts[4] = body, …
    for (let i = 1; i < parts.length; i += 2) {
      const rawPath = String(parts[i] || '').trim();
      const body = String(parts[i + 1] || '');
      if (!rawPath) continue;
      const m = body.match(/```([a-zA-Z0-9_-]*)\s*\n([\s\S]*?)```/);
      if (!m) continue;
      const lang = m[1] || (typeof inferCodeLang === 'function' ? inferCodeLang(rawPath) : fallbackLanguage || 'plaintext');
      const content = m[2].replace(/\n$/, '');
      const filePath = rawPath
        .replace(/\\/g, '/')
        .replace(/^\.\//, '')
        .replace(/^\/+/, '');
      out.push({ filePath, content, language: lang, isCurrent: false });
    }
    if (out.length) return out;
  }
  // Single-file fallback — the existing extractCodeFence behaviour.
  const single = (typeof extractCodeFence === 'function') ? extractCodeFence(text) : '';
  if (single) {
    return [{ filePath: 'current', content: single, language: fallbackLanguage || 'plaintext', isCurrent: true }];
  }
  return [];
}

// Workspace boundary check. Rejects absolute paths, `..` traversal, and
// paths outside `codeWorkspace`. Returns the absolute path joined with
// the workspace root, or null on rejection. Uses `codeJoin` for the
// existing slash-style normalisation.
function _ensureWithinWorkspace(relPath) {
  if (!codeWorkspace) return null;
  const clean = String(relPath || '').replace(/\\/g, '/').trim();
  if (!clean) return null;
  if (clean.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(clean)) return null; // absolute
  if (clean.split('/').some(seg => seg === '..' || seg === '~')) return null;
  return codeJoin(codeWorkspace, clean);
}

async function submitCmdKBar() {
  const input = document.getElementById('cek-bar-input');
  const prompt = (input?.value || '').trim();
  if (!codeEditor || !prompt) { closeCmdKBar(); return; }
  const sel = codeEditor.getSelection();
  const model = codeEditor.getModel();
  if (!sel || !model) { closeCmdKBar(); return; }
  const selectedText = model.getValueInRange(sel) || '';
  const fullText = model.getValue();
  const language = (model.getLanguageId && model.getLanguageId()) || (typeof inferCodeLang === 'function' ? inferCodeLang(codeCurrentFile) : 'plaintext');
  const hasSelection = selectedText.length > 0;
  const fileLabel = codeCurrentFile || '(unsaved buffer)';

  // Show "thinking" state on the bar — disable input, swap placeholder.
  if (input) {
    input.disabled = true;
    input.placeholder = 'Thinking…';
  }
  const opRunId = (typeof opStartRun === 'function') ? opStartRun('ai.cmdk', `${prompt.slice(0, 60)} → ${fileLabel}`) : null;

  // PR-D1.4 — system prompt now allows multi-file output. Single-file
  // mode is preserved (one fenced block) — the model only fans out
  // when the instruction obviously affects multiple files (extract
  // helper, rename across imports, refactor with a new file, etc).
  const workspaceHint = codeWorkspace ? `Workspace root: ${codeWorkspace}` : '(no workspace open — file paths are buffer-only)';
  const sys = [
    `You are a code editor assistant. Apply the user's instruction to the ${hasSelection ? 'SELECTED CODE BLOCK' : 'CODE FILE'} shown.`,
    `${workspaceHint}\n\nIf the instruction CAN BE applied to ONE file → return the rewritten code in a SINGLE fenced code block, no headers, no prose:\n\`\`\`${language || ''}\n<entire new file or selection>\n\`\`\``,
    `If the instruction REQUIRES multiple files (extract helper into utils.ts, rename across imports, split a class, add a new file, etc) → return EACH file as a separate block in this exact format:\n===FILE: path/relative/to/workspace.ext===\n\`\`\`<language>\n<entire new content of that file>\n\`\`\`\n\nRules for multi-file mode:\n  • Every file path MUST be relative to the workspace root, no \`..\`, no absolute paths.\n  • Always include the FULL new content of each file (not a diff).\n  • For new files, pick a sensible relative path inside the workspace.\n  • The CURRENTLY EDITED file's path is: ${codeCurrentFile || '(unsaved)'} — refer to it by that path.\n  • NO prose outside the FILE blocks.`,
    `If the instruction can't be applied (ambiguous, destructive, would break the file), return the ORIGINAL code unchanged inside the fence — do not return prose.`,
    `Preserve original indentation. Keep line endings consistent.`,
    hasSelection
      ? `Currently editing ${fileLabel} (${language}), lines ${sel.startLineNumber}-${sel.endLineNumber} are selected.\nIn single-file mode return the replacement for THOSE LINES ONLY.`
      : `Currently editing ${fileLabel} (${language}), no selection — single-file mode means rewrite the WHOLE FILE.`,
  ].join('\n\n');
  const userMsg = `${prompt}\n\n\`\`\`${language || ''}\n${hasSelection ? selectedText : fullText}\n\`\`\``;

  let res = null;
  try {
    const activeProv = (typeof prov !== 'undefined' && prov) ? prov : 'claude';
    const opts = (typeof aiOptsForProvider === 'function') ? aiOptsForProvider(activeProv) : {};
    res = await H.ai([{ role: 'user', content: userMsg }], activeProv, sys, opts);
  } catch (e) {
    res = { error: e?.message || String(e) };
  }

  // Re-enable bar so user can retry if needed.
  if (input) {
    input.disabled = false;
    input.placeholder = 'Edit selection with AI…';
  }

  if (!res || res.error) {
    if (opRunId && typeof opLog === 'function') opLog(`⌘K AI error: ${res?.error || 'unknown'}`, 'error');
    if (opRunId && typeof opEndRun === 'function') opEndRun(opRunId, 'error');
    if (typeof addMsg === 'function') addMsg('bot', `⚠️ ⌘K AI error: ${res?.error || 'unknown'}`);
    closeCmdKBar();
    return;
  }
  const reply = res.reply || '';

  // Token accounting (so the Inspector's Cost tab + chat-status-bar
  // pill register the cost of the ⌘K turn).
  try { if (typeof trackTokens === 'function') trackTokens(reply, 'assistant', (typeof prov !== 'undefined' ? prov : 'claude'), res.usage); } catch(_){}

  // Parse — single-file or multi-file? parseCodeEditReply returns
  // [] if neither pattern matched.
  const parsedFiles = parseCodeEditReply(reply, codeCurrentFile, language);
  if (!parsedFiles.length) {
    if (typeof opLog === 'function') opLog(`⌘K AI returned no fenced code (${reply.length} chars)`, 'error');
    if (opRunId && typeof opEndRun === 'function') opEndRun(opRunId, 'error');
    if (typeof addMsg === 'function') addMsg('bot', `⚠️ ⌘K: AI didn't return a code block. Raw reply:\n\n${reply.slice(0, 1500)}`);
    closeCmdKBar();
    return;
  }

  // Hide the bar before showing the modal so they don't visually stack.
  closeCmdKBar();

  // ── Multi-file branch (D1.4) ─────────────────────────────────────
  if (parsedFiles.length > 1 || (parsedFiles[0] && !parsedFiles[0].isCurrent)) {
    await _runMultiFileEdit(parsedFiles, prompt, opRunId);
    return;
  }

  // ── Single-file branch (D1.2 + D1.3) ─────────────────────────────
  const replacement = parsedFiles[0].content;
  const before = hasSelection ? selectedText : fullText;
  const after = replacement;
  if (before === after) {
    if (typeof addMsg === 'function') addMsg('bot', `🪄 ⌘K: AI returned identical code — nothing to change.`);
    if (opRunId && typeof opEndRun === 'function') opEndRun(opRunId, 'done');
    return;
  }

  // PR-D1.3 — switched from binary-accept requestDiffPermission to the
  // per-hunk variant. Returns the merged text reflecting only the hunks
  // the user kept checked. Empty acceptance = effectively a reject.
  const result = await requestDiffPermissionPerHunk({
    title: hasSelection ? `${fileLabel} (lines ${sel.startLineNumber}-${sel.endLineNumber})` : fileLabel,
    description: `⌘K: ${prompt}`,
    before,
    after,
    language,
  });
  if (!result || !result.ok) {
    if (typeof opLog === 'function') opLog(`⌘K rejected by user`, 'error');
    if (opRunId && typeof opEndRun === 'function') opEndRun(opRunId, 'cancelled');
    return;
  }
  if (result.accepted === 0) {
    if (typeof opLog === 'function') opLog(`⌘K — no hunks accepted`, 'tool');
    if (opRunId && typeof opEndRun === 'function') opEndRun(opRunId, 'cancelled');
    if (typeof codeSetStatus === 'function') codeSetStatus(`⌘K closed without changes (no hunks accepted).`);
    return;
  }
  const merged = result.mergedAfter;

  // Apply via Monaco's executeEdits so undo-stack works (Ctrl+Z reverts).
  try {
    if (hasSelection) {
      codeEditor.executeEdits('cmdk-d1.3', [{ range: sel, text: merged }]);
    } else {
      codeEditor.setValue(merged);
    }
    codeEditor.focus();
  } catch (e) {
    if (typeof opLog === 'function') opLog(`⌘K apply failed: ${e?.message}`, 'error');
    if (opRunId && typeof opEndRun === 'function') opEndRun(opRunId, 'error');
    if (typeof addMsg === 'function') addMsg('bot', `⚠️ ⌘K apply failed: ${e?.message}`);
    return;
  }

  if (typeof opLog === 'function') opLog(`⌘K applied ${result.accepted} hunk${result.accepted === 1 ? '' : 's'}: "${prompt.slice(0, 80)}" → ${fileLabel}${hasSelection ? ` (L${sel.startLineNumber}-${sel.endLineNumber})` : ''}`, 'tool');
  if (opRunId && typeof opEndRun === 'function') opEndRun(opRunId, 'done');
  if (typeof codeSetStatus === 'function') codeSetStatus(`⌘K applied ${result.accepted} hunk${result.accepted === 1 ? '' : 's'}. Press 💾 Save (Ctrl+S) to write to disk, or Ctrl+Z to undo.`);
  // PR-D1.5 — record this edit so it can be browsed / undone via the
  // history dropdown. Single-file selection edit: snapshot is the
  // pre-merge `before` (whole file content for whole-file mode, or
  // the entire file content captured before the executeEdits for
  // selection mode — we take the latter from `fullText`).
  try {
    cekRecordHistory({
      prompt,
      files: [{
        relPath: fileLabel,
        absPath: codeCurrentFile || '',
        isCurrent: true,
        before: fullText,           // entire file before the edit
        mergedAfter: hasSelection
          ? (fullText.slice(0, model.getOffsetAt(sel.getStartPosition()))
             + merged
             + fullText.slice(model.getOffsetAt(sel.getEndPosition())))
          : merged,
        accepted: result.accepted,
      }],
    });
  } catch(_){}
  // Auto-commit if enabled and the workspace is a git repo.
  try { cekMaybeAutoCommit(prompt); } catch(_){}
}

// Global hotkey: also bind ⌘K at the document level when Code Mode is
// active, so the user can hit it even when focus drifted to the textarea
// fallback (Monaco unavailable) or to the file tree. Monaco's own
// addCommand still wins inside the editor — this is a safety net.
document.addEventListener('keydown', (e) => {
  if (!document.body.classList.contains('code-mode-active')) return;
  const isCmdK = (e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey;
  if (!isCmdK) return;
  // Don't hijack ⌘K in inputs that aren't the editor (chat input, search,
  // etc) — those have their own meanings. Only fire when we're inside
  // the code-shell area.
  const inCodeShell = e.target?.closest?.('.code-shell, .code-monaco, .code-editor, .code-files, .code-terminal');
  if (!inCodeShell) return;
  e.preventDefault();
  openCmdKBar();
});

function codeGetValue(){
  return codeEditor ? codeEditor.getValue() : (document.getElementById('code-editor')?.value || '');
}

function codeSetValue(value, langName){
  const text = String(value ?? '');
  const ta = document.getElementById('code-editor');
  if(ta) ta.value = text;
  if(codeEditor){
    const model = codeEditor.getModel();
    codeEditor.setValue(text);
    if(model && langName) monaco.editor.setModelLanguage(model, langName);
  }
}

function codeSelectionSnapshot(){
  if(codeEditor){
    const model = codeEditor.getModel();
    const sel = codeEditor.getSelection();
    const selected = model && sel ? model.getValueInRange(sel) : '';
    const full = codeEditor.getValue();
    return { type:'monaco', range:sel, selected, full, hasSelection:!!selected };
  }
  const editor=document.getElementById('code-editor');
  const start=editor?.selectionStart || 0;
  const end=editor?.selectionEnd || 0;
  const full=editor?.value || '';
  return { type:'textarea', start, end, selected:full.slice(start,end), full, hasSelection:end>start };
}

function codeReplaceSnapshot(snapshot, replacement){
  const text = String(replacement ?? '');
  if(codeEditor && snapshot?.type === 'monaco'){
    const model = codeEditor.getModel();
    const range = snapshot.hasSelection && snapshot.range ? snapshot.range : model.getFullModelRange();
    codeEditor.executeEdits('horizon-ai', [{ range, text, forceMoveMarkers:true }]);
    codeEditor.focus();
    return;
  }
  const editor=document.getElementById('code-editor');
  if(!editor) return;
  if(snapshot?.hasSelection){
    editor.value = editor.value.slice(0, snapshot.start) + text + editor.value.slice(snapshot.end);
    editor.selectionStart = snapshot.start;
    editor.selectionEnd = snapshot.start + text.length;
  } else {
    editor.value = text;
  }
}

function extractCodeFence(text){
  const raw = String(text || '');
  const matches = [...raw.matchAll(/```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)```/g)];
  if(!matches.length) return '';
  return matches[matches.length - 1][1].replace(/\n$/,'');
}

function buildDiffPreview(before, after, maxLines=80){
  const a = String(before ?? '').split(/\r?\n/);
  const b = String(after ?? '').split(/\r?\n/);
  let start = 0;
  while(start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1, endB = b.length - 1;
  while(endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB--; }
  const removed = a.slice(start, endA + 1);
  const added = b.slice(start, endB + 1);
  const lines = [`@@ line ${start + 1} @@`];
  removed.slice(0, maxLines/2).forEach(line => lines.push(`- ${line}`));
  added.slice(0, maxLines/2).forEach(line => lines.push(`+ ${line}`));
  if(removed.length + added.length > maxLines) lines.push('... diff truncated ...');
  return lines.join('\n') || 'No text changes.';
}

function sleepMs(ms){ return new Promise(r => setTimeout(r, ms)); }

function appendTerminalFallback(text){
  const out=document.getElementById('code-terminal-output');
  if(out) {
    out.textContent += String(text || '');
    out.scrollTop = out.scrollHeight;
  }
}

async function initWorkspaceTerminal(force=false){
  if(!codeWorkspace) return { ok:false, err:'Choose a workspace first.' };
  const host=document.getElementById('code-xterm');
  if(!host || typeof window.Terminal !== 'function') {
    document.getElementById('code-xterm')?.style.setProperty('display','none');
    document.getElementById('code-terminal-output')?.style.setProperty('display','block');
    return { ok:false, err:'xterm unavailable; fallback command runner active.' };
  }
  document.getElementById('code-terminal-output')?.style.setProperty('display','none');
  host.style.display='block';
  if(force && codeTerminalId) {
    await H.terminalKill?.(codeTerminalId).catch(()=>null);
    codeTerminalId='';
  }
  if(!codeTerminal){
    codeTerminal = new Terminal({
      cursorBlink:true,
      fontFamily:'JetBrains Mono, Consolas, monospace',
      fontSize:11,
      theme:{ background:'#05070c', foreground:'#d8deea', cursor:'#f3b250' },
      convertEol:true,
      scrollback:3000,
    });
    codeTerminal.open(host);
    codeTerminal.onData(data => {
      if(codeTerminalId) H.terminalWrite?.(codeTerminalId, data).catch(()=>null);
    });
    if(!codeTerminalResizeInstalled && codeTerminal.onResize){
      codeTerminal.onResize(size => {
        if(codeTerminalId) H.terminalResize?.(codeTerminalId, size.cols, size.rows).catch(()=>null);
      });
      codeTerminalResizeInstalled = true;
    }
  }
  if(!codeTerminalListenerInstalled && H.onTerminalData){
    H.onTerminalData(payload => {
      if(!payload || payload.id !== codeTerminalId) return;
      try { codeTerminal?.write(payload.data || ''); } catch(_) { appendTerminalFallback(payload.data || ''); }
    });
    codeTerminalListenerInstalled = true;
  }
  if(!codeTerminalId){
    const r=await H.terminalCreate?.(
      `code-${Date.now().toString(36)}`,
      codeDir || '',
      codeTerminal?.cols || 100,
      codeTerminal?.rows || 30
    ).catch(e=>({ok:false,err:e.message}));
    if(!r?.ok){ appendTerminalFallback(`\nTerminal failed: ${r?.err || 'unknown'}\n`); return r; }
    codeTerminalId=r.id;
    const backend = r.nativePty ? 'native PTY' : 'fallback shell pipe';
    codeTerminal.write(`Horizon workspace terminal (${backend})\r\n${r.cwd}\r\n\r\n`);
    if(!r.nativePty && r.nativeError) codeTerminal.write(`Native PTY unavailable: ${r.nativeError}\r\n\r\n`);
    await H.terminalResize?.(codeTerminalId, codeTerminal?.cols || 100, codeTerminal?.rows || 30).catch(()=>null);
  }
  setTimeout(()=>{ try { codeTerminal?.focus(); } catch(_){} }, 50);
  return { ok:true, id:codeTerminalId };
}

async function restartWorkspaceTerminal(){
  if(codeTerminal){ try { codeTerminal.clear(); } catch(_){} }
  codeTerminalId='';
  await initWorkspaceTerminal(true);
}

// PR-D1.3 — per-hunk accept/reject diff modal.
// Like requestDiffPermission but returns either:
//   { ok: false }                              user rejected the whole change
//   { ok: true, mergedAfter, accepted: N }     user accepted ≥0 hunks; the
//                                              merged result is the original
//                                              `before` with only the accepted
//                                              hunks applied, line numbers
//                                              correct because we splice from
//                                              the bottom up.
// Hunks come from Monaco's diffEditor.getLineChanges(), which exposes a
// `LineChange` per contiguous block of differences:
//   { originalStartLineNumber, originalEndLineNumber,
//     modifiedStartLineNumber, modifiedEndLineNumber }
// originalEndLineNumber === 0 → pure addition (no original lines).
// modifiedEndLineNumber === 0 → pure deletion (no modified lines).
async function requestDiffPermissionPerHunk({ title='Review changes', description='', before='', after='', language='plaintext' } = {}) {
  await initCodeEditor().catch(() => false);
  if (!window.monaco) {
    // No Monaco → fall back to the simple binary modal so the flow
    // still works on diagnostics-only setups. All-or-nothing in that
    // case (mergedAfter = `after`).
    const ok = await requestDiffPermission({ title, description, before, after, language });
    return ok ? { ok: true, mergedAfter: after, accepted: ok ? 1 : 0 } : { ok: false };
  }
  const beforeLines = String(before ?? '').split(/\r?\n/);
  const afterLines = String(after ?? '').split(/\r?\n/);

  return await new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'diff-overlay';
    overlay.innerHTML = `
      <div class="diff-card cek-hunk-card">
        <div class="diff-head">
          <span class="diff-title">${esc(title)}</span>
          <span class="diff-desc">${esc(description)}</span>
        </div>
        <div class="cek-hunk-body">
          <aside class="cek-hunk-list" id="cek-hunk-list">
            <div class="cek-hunk-list-header">
              <span class="cek-hunk-list-title">HUNKS</span>
              <span class="cek-hunk-list-summary" id="cek-hunk-summary">—</span>
            </div>
            <div class="cek-hunk-list-actions">
              <button class="btn btn-sm" id="cek-hunk-all">Accept all</button>
              <button class="btn btn-sm" id="cek-hunk-none">Reject all</button>
            </div>
            <ul class="cek-hunk-items" id="cek-hunk-items"></ul>
          </aside>
          <div class="diff-host cek-hunk-diff"></div>
        </div>
        <div class="diff-actions">
          <button class="perm-btn deny" data-act="deny">Cancel</button>
          <button class="perm-btn allow" data-act="apply">Apply selected</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    let diff = null;
    let original = null;
    let modified = null;
    let lineChanges = [];
    let acceptedFlags = []; // boolean per change — default ON

    const cleanup = (value) => {
      try { diff?.dispose?.(); } catch(_){}
      try { overlay.remove(); } catch(_){}
      resolve(value);
    };

    try {
      const host = overlay.querySelector('.diff-host');
      original = monaco.editor.createModel(String(before ?? ''), language);
      modified = monaco.editor.createModel(String(after ?? ''), language);
      diff = monaco.editor.createDiffEditor(host, {
        theme: 'vs-dark',
        automaticLayout: true,
        renderSideBySide: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        readOnly: true,
      });
      diff.setModel({ original, modified });
      const oldDispose = diff.dispose.bind(diff);
      diff.dispose = () => { try { original.dispose(); modified.dispose(); } catch(_){} oldDispose(); };

      // Wait for Monaco to compute the diff, then populate the hunk list.
      const onUpdate = () => {
        try {
          const changes = diff.getLineChanges() || [];
          lineChanges = changes;
          acceptedFlags = changes.map(() => true); // all accepted by default
          renderHunkItems();
        } catch (e) {
          console.warn('cek hunk-list build failed:', e?.message);
        }
      };
      // onDidUpdateDiff fires once the diff worker finishes; it can also
      // fire never if the contents are equal — in that case getLineChanges()
      // returns []. We schedule a microtask + a timeout fallback.
      diff.onDidUpdateDiff?.(onUpdate);
      setTimeout(onUpdate, 200);
    } catch (e) {
      console.warn('cek diff render failed:', e?.message);
      overlay.querySelector('.cek-hunk-diff').innerHTML =
        `<pre class="perm-detail" style="max-height:none;height:100%;box-sizing:border-box">${esc(buildDiffPreview(before, after, 200))}</pre>`;
    }

    function fmtRange(start, end) {
      if (!end) return `+${start}`;
      if (!start) return `-${end}`;
      if (start === end) return `${start}`;
      return `${start}-${end}`;
    }

    function snippet(lines, startLn, endLn, max = 2) {
      if (!startLn || !endLn || endLn < startLn) return '';
      const slice = lines.slice(startLn - 1, Math.min(endLn, startLn - 1 + max));
      return slice.join(' ⏎ ').trim().slice(0, 80);
    }

    function renderHunkItems() {
      const items = document.getElementById('cek-hunk-items');
      const summary = document.getElementById('cek-hunk-summary');
      if (!items || !summary) return;
      if (!lineChanges.length) {
        items.innerHTML = '<li class="cek-hunk-empty">No changes detected — files are identical.</li>';
        summary.textContent = '0 / 0';
        return;
      }
      items.innerHTML = lineChanges.map((ch, i) => {
        const isAdd = ch.originalEndLineNumber === 0;
        const isDel = ch.modifiedEndLineNumber === 0;
        const kind = isAdd ? 'add' : isDel ? 'del' : 'mod';
        const kindLabel = isAdd ? 'ADD' : isDel ? 'DEL' : 'MOD';
        const ofRange = fmtRange(ch.originalStartLineNumber, ch.originalEndLineNumber);
        const mfRange = fmtRange(ch.modifiedStartLineNumber, ch.modifiedEndLineNumber);
        const previewSrc = isAdd ? snippet(afterLines, ch.modifiedStartLineNumber, ch.modifiedEndLineNumber)
                          : isDel ? snippet(beforeLines, ch.originalStartLineNumber, ch.originalEndLineNumber)
                          : snippet(afterLines, ch.modifiedStartLineNumber, ch.modifiedEndLineNumber);
        return `
          <li class="cek-hunk-item ${acceptedFlags[i] ? 'on' : 'off'} kind-${kind}" data-idx="${i}">
            <label class="cek-hunk-row">
              <input type="checkbox" data-idx="${i}" ${acceptedFlags[i] ? 'checked' : ''}/>
              <span class="cek-hunk-kind">${kindLabel}</span>
              <span class="cek-hunk-range">L${ofRange} → L${mfRange}</span>
            </label>
            <div class="cek-hunk-preview" title="${esc(previewSrc)}">${esc(previewSrc) || '<i style="opacity:.5">(empty)</i>'}</div>
          </li>`;
      }).join('');
      // Wire checkboxes.
      items.querySelectorAll('input[type=checkbox]').forEach((box) => {
        box.onchange = () => {
          const i = Number(box.dataset.idx);
          acceptedFlags[i] = box.checked;
          const li = items.querySelector(`li[data-idx="${i}"]`);
          if (li) li.classList.toggle('on', box.checked);
          if (li) li.classList.toggle('off', !box.checked);
          updateSummary();
        };
      });
      updateSummary();
    }
    function updateSummary() {
      const summary = document.getElementById('cek-hunk-summary');
      if (!summary) return;
      const accepted = acceptedFlags.filter(Boolean).length;
      summary.textContent = `${accepted} / ${lineChanges.length}`;
    }

    overlay.querySelector('#cek-hunk-all').onclick = () => {
      acceptedFlags = lineChanges.map(() => true);
      renderHunkItems();
    };
    overlay.querySelector('#cek-hunk-none').onclick = () => {
      acceptedFlags = lineChanges.map(() => false);
      renderHunkItems();
    };
    overlay.querySelector('[data-act="deny"]').onclick = () => cleanup({ ok: false });
    overlay.querySelector('[data-act="apply"]').onclick = () => {
      // Build merged text by applying accepted hunks bottom-up (so line
      // numbers in earlier hunks stay valid as we splice). Original is
      // the source of truth; for each accepted hunk we replace the
      // original line range with the modified line range.
      const result = beforeLines.slice();
      const accepted = lineChanges
        .map((ch, i) => acceptedFlags[i] ? ch : null)
        .filter(Boolean)
        .sort((a, b) => b.originalStartLineNumber - a.originalStartLineNumber);
      for (const ch of accepted) {
        const oStart = ch.originalEndLineNumber === 0
          ? ch.originalStartLineNumber       // pure-add: insert AFTER this line
          : ch.originalStartLineNumber - 1;  // 0-indexed splice
        const oCount = ch.originalEndLineNumber === 0
          ? 0
          : ch.originalEndLineNumber - ch.originalStartLineNumber + 1;
        const mLines = ch.modifiedEndLineNumber === 0
          ? []
          : afterLines.slice(ch.modifiedStartLineNumber - 1, ch.modifiedEndLineNumber);
        result.splice(oStart, oCount, ...mLines);
      }
      cleanup({ ok: true, mergedAfter: result.join('\n'), accepted: accepted.length });
    };
  });
}

// PR-D1.4 — multi-file edit orchestrator. See parseCodeEditReply +
// _ensureWithinWorkspace + submitCmdKBar dispatch above.
async function _runMultiFileEdit(parsedFiles, prompt, opRunId) {
  if (!codeWorkspace && parsedFiles.length > 1) {
    if (typeof addMsg === 'function') addMsg('bot', `⚠️ ⌘K: AI returned multi-file edits but no workspace is open. Open a workspace first (Code Mode → Choose folder).`);
    if (opRunId && typeof opEndRun === 'function') opEndRun(opRunId, 'error');
    return;
  }
  const resolved = [];
  for (const f of parsedFiles) {
    let absPath = '';
    let relPath = f.filePath;
    if (f.isCurrent) {
      absPath = codeCurrentFile || '';
      relPath = codeCurrentFile && codeWorkspace
        ? codeCurrentFile.replace(codeWorkspace, '').replace(/^[\\/]+/, '')
        : '(current buffer)';
    } else {
      absPath = _ensureWithinWorkspace(f.filePath);
      if (!absPath) {
        if (typeof addMsg === 'function') addMsg('bot', `⚠️ ⌘K: AI tried to edit a file outside the workspace: \`${f.filePath}\`. Aborted (no files changed).`);
        if (opRunId && typeof opEndRun === 'function') opEndRun(opRunId, 'error');
        return;
      }
    }
    let before = '';
    let isNew = false;
    if (f.isCurrent && codeEditor) {
      before = codeEditor.getModel()?.getValue() || '';
    } else if (absPath) {
      try {
        const r = await H.wsRead?.(absPath);
        if (r && r.ok && typeof r.content === 'string') {
          before = r.content;
        } else {
          isNew = true; before = '';
        }
      } catch (_) { isNew = true; before = ''; }
    }
    resolved.push({
      relPath: relPath || f.filePath,
      absPath,
      isCurrent: !!f.isCurrent,
      isNew,
      before,
      after: f.content,
      language: f.language || (typeof inferCodeLang === 'function' ? inferCodeLang(absPath || f.filePath) : 'plaintext'),
    });
  }
  const meaningful = resolved.filter(f => f.before !== f.after);
  if (!meaningful.length) {
    if (typeof addMsg === 'function') addMsg('bot', `🪄 ⌘K: AI returned identical content for all ${resolved.length} files — nothing to change.`);
    if (opRunId && typeof opEndRun === 'function') opEndRun(opRunId, 'done');
    return;
  }

  const modalResult = await requestMultiFileDiff({
    title: `⌘K · ${resolved.length} ${resolved.length === 1 ? 'file' : 'files'}`,
    description: prompt,
    files: resolved,
  });
  if (!modalResult || !modalResult.ok) {
    if (typeof opLog === 'function') opLog(`⌘K multi-file rejected by user`, 'error');
    if (opRunId && typeof opEndRun === 'function') opEndRun(opRunId, 'cancelled');
    return;
  }

  // Atomic apply with rollback on failure.
  const snapshots = modalResult.applied.map(f => ({ absPath: f.absPath, isCurrent: f.isCurrent, snapshot: f.before }));
  const written = [];
  let writeError = null;
  for (const f of modalResult.applied) {
    if (f.skipped) continue;
    try {
      if (f.isCurrent && codeEditor) {
        const m = codeEditor.getModel();
        if (m) {
          codeEditor.executeEdits('cmdk-d1.4', [{ range: m.getFullModelRange(), text: f.mergedAfter }]);
        }
      } else if (f.absPath) {
        const r = await H.wsWrite?.(f.absPath, f.mergedAfter);
        if (!r || r.ok === false) throw new Error(r?.error || 'wsWrite returned no result');
      }
      written.push(f);
    } catch (e) {
      writeError = { file: f.relPath, error: e?.message || String(e) };
      break;
    }
  }
  if (writeError) {
    for (const w of written) {
      try {
        const snap = snapshots.find(s => s.absPath === w.absPath || (s.isCurrent && w.isCurrent));
        if (!snap) continue;
        if (snap.isCurrent && codeEditor) {
          const m = codeEditor.getModel();
          if (m) codeEditor.executeEdits('cmdk-d1.4-rollback', [{ range: m.getFullModelRange(), text: snap.snapshot }]);
        } else if (snap.absPath) {
          await H.wsWrite?.(snap.absPath, snap.snapshot).catch(() => {});
        }
      } catch (_) {}
    }
    if (typeof opLog === 'function') opLog(`⌘K multi-file FAILED on ${writeError.file}: ${writeError.error}. Rolled back ${written.length} earlier files.`, 'error');
    if (opRunId && typeof opEndRun === 'function') opEndRun(opRunId, 'error');
    if (typeof addMsg === 'function') addMsg('bot', `⚠️ ⌘K multi-file apply failed on \`${writeError.file}\`: ${writeError.error}. ${written.length} earlier file(s) rolled back.`);
    return;
  }

  const totalHunks = modalResult.applied.reduce((sum, f) => sum + (f.accepted || 0), 0);
  const filesChanged = modalResult.applied.filter(f => !f.skipped && (f.accepted || 0) > 0).length;
  if (typeof opLog === 'function') opLog(`⌘K multi-file applied: ${totalHunks} hunk(s) across ${filesChanged} file(s) — ${prompt.slice(0, 80)}`, 'tool');
  if (opRunId && typeof opEndRun === 'function') opEndRun(opRunId, 'done');
  if (typeof codeSetStatus === 'function') codeSetStatus(`⌘K applied across ${filesChanged} file(s) (${totalHunks} hunks). Disk-written files saved; current-buffer changes need 💾 Save.`);
  if (typeof addMsg === 'function') addMsg('bot', `🪄 ⌘K applied **${totalHunks}** hunk${totalHunks === 1 ? '' : 's'} across **${filesChanged}** file${filesChanged === 1 ? '' : 's'}.`);
  try { if (typeof refreshCodeWorkspace === 'function') refreshCodeWorkspace(); } catch (_) {}
  // PR-D1.5 — record the multi-file edit so it's reachable from the
  // history dropdown and can be undone in one click. We only record
  // files that actually got writes (skipped=false, accepted>0) so
  // Undo doesn't trip over no-op entries.
  try {
    const recordedFiles = modalResult.applied
      .filter(f => !f.skipped && (f.accepted || 0) > 0)
      .map(f => ({
        relPath: f.relPath,
        absPath: f.absPath || '',
        isCurrent: !!f.isCurrent,
        before: f.before,
        mergedAfter: f.mergedAfter,
        accepted: f.accepted,
      }));
    if (recordedFiles.length) {
      cekRecordHistory({ prompt, files: recordedFiles });
      cekMaybeAutoCommit(prompt);
    }
  } catch (_) {}
}

// Multi-file diff modal with file tabs at top + per-hunk picker per file.
async function requestMultiFileDiff({ title='Review changes', description='', files=[] } = {}) {
  await initCodeEditor().catch(() => false);
  if (!window.monaco || !files.length) return { ok: false };

  return await new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'diff-overlay';
    overlay.innerHTML = `
      <div class="diff-card cek-mf-card">
        <div class="diff-head">
          <span class="diff-title">${esc(title)}</span>
          <span class="diff-desc">${esc(description)}</span>
        </div>
        <div class="cek-mf-tabs" id="cek-mf-tabs"></div>
        <div class="cek-mf-body">
          <aside class="cek-hunk-list" id="cek-hunk-list">
            <div class="cek-hunk-list-header">
              <span class="cek-hunk-list-title">HUNKS</span>
              <span class="cek-hunk-list-summary" id="cek-hunk-summary">—</span>
            </div>
            <div class="cek-hunk-list-actions">
              <button class="btn btn-sm" id="cek-hunk-all">Accept all in file</button>
              <button class="btn btn-sm" id="cek-hunk-none">Reject all in file</button>
            </div>
            <ul class="cek-hunk-items" id="cek-hunk-items"></ul>
          </aside>
          <div class="diff-host cek-hunk-diff" id="cek-mf-diff-host"></div>
        </div>
        <div class="diff-actions">
          <button class="perm-btn deny" data-act="deny">Cancel</button>
          <button class="perm-btn allow" data-act="apply">Apply all</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const state = files.map((f, idx) => ({
      idx, relPath: f.relPath, absPath: f.absPath,
      isCurrent: f.isCurrent, isNew: f.isNew, language: f.language,
      before: f.before || '', after: f.after || '',
      lineChanges: null, acceptedFlags: null,
    }));
    let activeIdx = 0;
    let diff = null, original = null, modified = null;

    const cleanup = (value) => {
      try { diff?.dispose?.(); } catch (_) {}
      try { overlay.remove(); } catch (_) {}
      resolve(value);
    };

    function fmtRange(start, end) {
      if (!end) return `+${start}`;
      if (!start) return `-${end}`;
      if (start === end) return `${start}`;
      return `${start}-${end}`;
    }
    function snippet(lines, startLn, endLn, max = 2) {
      if (!startLn || !endLn || endLn < startLn) return '';
      const slice = lines.slice(startLn - 1, Math.min(endLn, startLn - 1 + max));
      return slice.join(' ⏎ ').trim().slice(0, 80);
    }

    function renderTabs() {
      const tabs = document.getElementById('cek-mf-tabs');
      if (!tabs) return;
      tabs.innerHTML = state.map((s, i) => {
        const acc = Array.isArray(s.acceptedFlags) ? s.acceptedFlags.filter(Boolean).length : null;
        const tot = Array.isArray(s.lineChanges) ? s.lineChanges.length : null;
        const badge = tot === null
          ? '<span class="cek-mf-tab-badge cek-mf-tab-badge-pending">…</span>'
          : `<span class="cek-mf-tab-badge${acc === 0 ? ' cek-mf-tab-badge-zero' : ''}">${acc}/${tot}</span>`;
        const newPill = s.isNew ? '<span class="cek-mf-tab-new">NEW</span>' : '';
        const currentPill = s.isCurrent ? '<span class="cek-mf-tab-curr">EDITOR</span>' : '';
        return `<button class="cek-mf-tab${i === activeIdx ? ' on' : ''}" data-idx="${i}" title="${esc(s.relPath)}">
          <span class="cek-mf-tab-name">${esc(s.relPath)}</span>${newPill}${currentPill}${badge}
        </button>`;
      }).join('');
      tabs.querySelectorAll('button[data-idx]').forEach(btn => {
        btn.onclick = () => {
          const i = Number(btn.dataset.idx);
          if (i === activeIdx) return;
          activeIdx = i;
          renderTabs();
          renderActiveTab();
        };
      });
    }

    function renderHunkItems() {
      const items = document.getElementById('cek-hunk-items');
      const summary = document.getElementById('cek-hunk-summary');
      const s = state[activeIdx];
      if (!items || !summary || !s) return;
      const lcs = s.lineChanges || [];
      const beforeLines = (s.before || '').split(/\r?\n/);
      const afterLines = (s.after || '').split(/\r?\n/);
      if (!lcs.length) {
        items.innerHTML = '<li class="cek-hunk-empty">No changes detected for this file.</li>';
        summary.textContent = '0 / 0';
        return;
      }
      items.innerHTML = lcs.map((ch, i) => {
        const isAdd = ch.originalEndLineNumber === 0;
        const isDel = ch.modifiedEndLineNumber === 0;
        const kind = isAdd ? 'add' : isDel ? 'del' : 'mod';
        const kindLabel = isAdd ? 'ADD' : isDel ? 'DEL' : 'MOD';
        const ofRange = fmtRange(ch.originalStartLineNumber, ch.originalEndLineNumber);
        const mfRange = fmtRange(ch.modifiedStartLineNumber, ch.modifiedEndLineNumber);
        const previewSrc = isAdd ? snippet(afterLines, ch.modifiedStartLineNumber, ch.modifiedEndLineNumber)
                          : isDel ? snippet(beforeLines, ch.originalStartLineNumber, ch.originalEndLineNumber)
                          : snippet(afterLines, ch.modifiedStartLineNumber, ch.modifiedEndLineNumber);
        return `
          <li class="cek-hunk-item ${s.acceptedFlags[i] ? 'on' : 'off'} kind-${kind}" data-idx="${i}">
            <label class="cek-hunk-row">
              <input type="checkbox" data-idx="${i}" ${s.acceptedFlags[i] ? 'checked' : ''}/>
              <span class="cek-hunk-kind">${kindLabel}</span>
              <span class="cek-hunk-range">L${ofRange} → L${mfRange}</span>
            </label>
            <div class="cek-hunk-preview" title="${esc(previewSrc)}">${esc(previewSrc) || '<i style="opacity:.5">(empty)</i>'}</div>
          </li>`;
      }).join('');
      items.querySelectorAll('input[type=checkbox]').forEach((box) => {
        box.onchange = () => {
          const i = Number(box.dataset.idx);
          s.acceptedFlags[i] = box.checked;
          const li = items.querySelector(`li[data-idx="${i}"]`);
          if (li) { li.classList.toggle('on', box.checked); li.classList.toggle('off', !box.checked); }
          updateSummary();
          renderTabs();
        };
      });
      updateSummary();
    }
    function updateSummary() {
      const summary = document.getElementById('cek-hunk-summary');
      const s = state[activeIdx];
      if (!summary || !s) return;
      const accepted = (s.acceptedFlags || []).filter(Boolean).length;
      const total = (s.lineChanges || []).length;
      summary.textContent = `${accepted} / ${total}`;
    }

    function renderActiveTab() {
      const host = document.getElementById('cek-mf-diff-host');
      if (!host) return;
      const s = state[activeIdx];
      if (!s) return;
      try { diff?.dispose?.(); } catch (_) {}
      diff = null; original = null; modified = null;
      host.innerHTML = '';
      try {
        original = monaco.editor.createModel(s.before, s.language || 'plaintext');
        modified = monaco.editor.createModel(s.after, s.language || 'plaintext');
        diff = monaco.editor.createDiffEditor(host, {
          theme: 'vs-dark', automaticLayout: true, renderSideBySide: true,
          minimap: { enabled: false }, scrollBeyondLastLine: false, readOnly: true,
        });
        diff.setModel({ original, modified });
        const oldDispose = diff.dispose.bind(diff);
        diff.dispose = () => { try { original.dispose(); modified.dispose(); } catch (_) {} oldDispose(); };
        const onUpdate = () => {
          try {
            const changes = diff.getLineChanges() || [];
            s.lineChanges = changes;
            s.acceptedFlags = changes.map(() => true);
            renderHunkItems();
            renderTabs();
          } catch (e) { console.warn('cek mf hunks build failed:', e?.message); }
        };
        diff.onDidUpdateDiff?.(onUpdate);
        setTimeout(onUpdate, 200);
      } catch (e) {
        console.warn('cek mf diff render failed:', e?.message);
        host.innerHTML = `<pre class="perm-detail" style="max-height:none;height:100%;box-sizing:border-box">${esc(buildDiffPreview(s.before, s.after, 200))}</pre>`;
      }
    }

    overlay.querySelector('#cek-hunk-all').onclick = () => {
      const s = state[activeIdx];
      if (s && Array.isArray(s.lineChanges)) {
        s.acceptedFlags = s.lineChanges.map(() => true);
        renderHunkItems(); renderTabs();
      }
    };
    overlay.querySelector('#cek-hunk-none').onclick = () => {
      const s = state[activeIdx];
      if (s && Array.isArray(s.lineChanges)) {
        s.acceptedFlags = s.lineChanges.map(() => false);
        renderHunkItems(); renderTabs();
      }
    };
    overlay.querySelector('[data-act="deny"]').onclick = () => cleanup({ ok: false });
    overlay.querySelector('[data-act="apply"]').onclick = () => {
      const applied = state.map((s) => {
        // Files the user never visited still default to accept-all.
        if (s.lineChanges == null) {
          return { relPath: s.relPath, absPath: s.absPath, isCurrent: s.isCurrent, isNew: s.isNew,
                   before: s.before, mergedAfter: s.after, accepted: 1, skipped: false };
        }
        const beforeLines = (s.before || '').split(/\r?\n/);
        const afterLines = (s.after || '').split(/\r?\n/);
        const result = beforeLines.slice();
        const acceptedHunks = s.lineChanges
          .map((ch, i) => s.acceptedFlags[i] ? ch : null)
          .filter(Boolean)
          .sort((a, b) => b.originalStartLineNumber - a.originalStartLineNumber);
        for (const ch of acceptedHunks) {
          const oStart = ch.originalEndLineNumber === 0 ? ch.originalStartLineNumber : ch.originalStartLineNumber - 1;
          const oCount = ch.originalEndLineNumber === 0 ? 0 : ch.originalEndLineNumber - ch.originalStartLineNumber + 1;
          const mLines = ch.modifiedEndLineNumber === 0 ? [] : afterLines.slice(ch.modifiedStartLineNumber - 1, ch.modifiedEndLineNumber);
          result.splice(oStart, oCount, ...mLines);
        }
        return { relPath: s.relPath, absPath: s.absPath, isCurrent: s.isCurrent, isNew: s.isNew,
                 before: s.before, mergedAfter: result.join('\n'),
                 accepted: acceptedHunks.length, skipped: acceptedHunks.length === 0 };
      });
      cleanup({ ok: true, applied });
    };

    renderTabs();
    renderActiveTab();
  });
}

// ═══ PR-D1.5 ⌘K HISTORY + UNDO + AUTO-COMMIT ═══════════════════════════
// In-memory LRU mirror of `cmdKHistory` settingsStore key. Each entry:
//   { id, ts, prompt,
//     files: [{ relPath, absPath, isCurrent, before, mergedAfter, accepted }] }
// Loaded on init, persisted on every push. Capped at CEK_HISTORY_MAX so
// the settingsStore entry stays small (the `before` snapshot can be
// large for whole-file edits; 10 × ~200KB worst case = 2MB which is
// well within electron-store comfort).
var _cekHistory = [];
var CEK_HISTORY_MAX = 10;
var _cekAutoCommit = false;

(async function _cekBootHistory() {
  try {
    const raw = await H.get?.('cmdKHistory');
    if (raw) {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (Array.isArray(parsed)) _cekHistory = parsed.slice(0, CEK_HISTORY_MAX);
    }
  } catch (_) {}
  try {
    const flag = await H.get?.('cmdKAutoCommit');
    _cekAutoCommit = !!flag;
  } catch (_) {}
  // Reflect into the toolbar buttons once everything's mounted.
  try { cekRefreshToolbar(); } catch (_) {}
})();

function cekRefreshToolbar() {
  const cnt = document.getElementById('cek-history-count');
  if (cnt) cnt.textContent = `(${_cekHistory.length})`;
  const ac = document.getElementById('cek-autocommit-btn');
  if (ac) {
    ac.textContent = `⚙ auto-commit: ${_cekAutoCommit ? 'on' : 'off'}`;
    ac.classList.toggle('on', _cekAutoCommit);
  }
  const undo = document.getElementById('cek-undo-btn');
  if (undo) undo.disabled = !_cekHistory.length;
}

function cekRecordHistory(entry) {
  if (!entry || !Array.isArray(entry.files) || !entry.files.length) return;
  const id = 'cek_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  _cekHistory.unshift({
    id,
    ts: Date.now(),
    prompt: String(entry.prompt || ''),
    files: entry.files.map(f => ({
      relPath: String(f.relPath || ''),
      absPath: String(f.absPath || ''),
      isCurrent: !!f.isCurrent,
      before: String(f.before ?? ''),
      mergedAfter: String(f.mergedAfter ?? ''),
      accepted: Number(f.accepted || 0),
    })),
  });
  if (_cekHistory.length > CEK_HISTORY_MAX) _cekHistory = _cekHistory.slice(0, CEK_HISTORY_MAX);
  try { H.set?.('cmdKHistory', JSON.stringify(_cekHistory)); } catch (_) {}
  cekRefreshToolbar();
}

// Undo: take the most recent (or specified) entry and restore each
// file's `before` snapshot. Uses Monaco executeEdits for the open
// buffer so Ctrl+Z still works after the undo, and H.wsWrite for
// the rest. Removes the entry from history after a successful undo.
async function cekUndoEntry(entryId = null) {
  const entry = entryId
    ? _cekHistory.find(e => e.id === entryId)
    : _cekHistory[0];
  if (!entry) {
    if (typeof codeSetStatus === 'function') codeSetStatus('No ⌘K edits to undo.', true);
    return false;
  }
  const written = [];
  let err = null;
  for (const f of entry.files) {
    try {
      if (f.isCurrent && codeEditor) {
        const m = codeEditor.getModel();
        if (m) codeEditor.executeEdits('cmdk-undo', [{ range: m.getFullModelRange(), text: f.before }]);
      } else if (f.absPath) {
        const r = await H.wsWrite?.(f.absPath, f.before);
        if (!r || r.ok === false) throw new Error(r?.error || 'wsWrite returned no result');
      }
      written.push(f);
    } catch (e) {
      err = { file: f.relPath, error: e?.message || String(e) };
      break;
    }
  }
  if (err) {
    // No clean rollback path here — the original `before` IS the
    // restore target. Best we can do is surface the error.
    if (typeof opLog === 'function') opLog(`⌘K Undo FAILED on ${err.file}: ${err.error}. Restored ${written.length} file(s).`, 'error');
    if (typeof addMsg === 'function') addMsg('bot', `⚠️ Undo failed on \`${err.file}\`: ${err.error}. ${written.length} earlier file(s) restored.`);
    return false;
  }
  // Drop the entry from history + persist.
  _cekHistory = _cekHistory.filter(e => e.id !== entry.id);
  try { H.set?.('cmdKHistory', JSON.stringify(_cekHistory)); } catch (_) {}
  cekRefreshToolbar();
  if (typeof opLog === 'function') opLog(`⌘K Undo: restored ${entry.files.length} file(s) — "${entry.prompt.slice(0, 60)}"`, 'tool');
  if (typeof codeSetStatus === 'function') codeSetStatus(`Undone: ${entry.files.length} file(s) restored. Press 💾 Save to persist current-buffer rollback.`);
  if (typeof addMsg === 'function') addMsg('bot', `↶ ⌘K undone: **${entry.files.length}** file${entry.files.length === 1 ? '' : 's'} restored from snapshot of "${entry.prompt.slice(0, 80)}".`);
  // Refresh workspace tree in case the undo restored a file the AI
  // had created (we end up with empty content rather than removing
  // the file — that's a known limitation; document it in the README).
  try { if (typeof refreshCodeWorkspace === 'function') refreshCodeWorkspace(); } catch (_) {}
  return true;
}
window.cekUndoLast = function () { return cekUndoEntry(null); };

// Toggle the auto-commit setting + persist. The actual commit happens
// in cekMaybeAutoCommit() at apply time.
window.cekToggleAutoCommit = async function () {
  _cekAutoCommit = !_cekAutoCommit;
  try { await H.set?.('cmdKAutoCommit', _cekAutoCommit); } catch (_) {}
  cekRefreshToolbar();
  if (typeof codeSetStatus === 'function') {
    codeSetStatus(_cekAutoCommit
      ? '⌘K auto-commit ON — successful edits will run `git add -A && git commit -m "AI: …"` (asks permission first time).'
      : '⌘K auto-commit OFF.');
  }
};

// Fire a git commit after a successful ⌘K apply, if:
//   - _cekAutoCommit is true
//   - workspace is open
//   - workspace is a git repo (we check via H.wsRead `.git/HEAD`)
//   - permission gate accepted (uses existing requestPermission)
// First-time use prompts; subsequent commits run silently.
async function cekMaybeAutoCommit(prompt) {
  if (!_cekAutoCommit) return;
  if (!codeWorkspace) return;
  // Cheap check: does .git/HEAD exist?
  try {
    const headPath = codeJoin(codeWorkspace, '.git/HEAD');
    const head = await H.wsRead?.(headPath);
    if (!head || head.ok === false) return; // not a git repo
  } catch (_) { return; }
  // First-time permission gate. We persist the answer in
  // `permissionAllowlist` via the existing helper if available;
  // simpler ad-hoc gate using window.confirm as a fallback.
  if (typeof window._cekAutoCommitConfirmed !== 'boolean') {
    const ok = typeof requestPermission === 'function'
      ? await requestPermission({
          eyebrow: 'AUTO-COMMIT',
          title: 'Run `git add -A && git commit -m "AI: …"` after every ⌘K?',
          description: 'You enabled auto-commit. Horizon will commit each successful AI edit so you have an undo trail in git history. Disable it any time via the toolbar toggle.',
          detail: `git add -A\ngit commit -m "AI: ${(prompt || '').slice(0, 60)}"`,
        })
      : confirm('Auto-commit AI edits to git?');
    if (!ok) {
      _cekAutoCommit = false;
      try { await H.set?.('cmdKAutoCommit', false); } catch (_) {}
      cekRefreshToolbar();
      return;
    }
    window._cekAutoCommitConfirmed = true;
  }
  const safePrompt = String(prompt || '').replace(/"/g, '\\"').slice(0, 60);
  const cmd = `git add -A && git commit -m "AI: ${safePrompt || 'edit'}"`;
  try {
    const r = await H.wsShell?.(cmd);
    if (r && r.ok) {
      if (typeof opLog === 'function') opLog(`⌘K auto-commit: ${safePrompt}`, 'tool');
    } else if (r && r.err) {
      if (typeof opLog === 'function') opLog(`⌘K auto-commit failed: ${(r.err || '').slice(0, 200)}`, 'error');
    }
  } catch (e) {
    if (typeof opLog === 'function') opLog(`⌘K auto-commit threw: ${e?.message || e}`, 'error');
  }
}

// History dropdown — toggles the .cek-history-pop popover anchored
// under the toolbar button. Renders the LRU as a card list with per-
// entry Undo button.
window.cekHistoryToggle = function (ev) {
  try { ev?.stopPropagation(); } catch(_){}
  const pop = document.getElementById('cek-history-pop');
  const btn = document.getElementById('cek-history-btn');
  if (!pop || !btn) return;
  if (pop.classList.contains('show')) { pop.classList.remove('show'); return; }
  if (!_cekHistory.length) {
    pop.innerHTML = `<div class="cek-history-empty">No ⌘K edits yet. Try selecting code and pressing ⌘K.</div>`;
  } else {
    pop.innerHTML = `
      <div class="cek-history-h">
        <span class="cek-history-h-t">⌘K HISTORY · ${_cekHistory.length}</span>
        <button class="btn btn-sm cek-history-clear" onclick="cekClearHistory()">Clear</button>
      </div>
      <ul class="cek-history-list">
        ${_cekHistory.map(e => {
          const ago = (() => {
            const dt = Date.now() - e.ts;
            if (dt < 60_000) return 'just now';
            if (dt < 3600_000) return Math.floor(dt / 60_000) + 'm ago';
            if (dt < 86400_000) return Math.floor(dt / 3600_000) + 'h ago';
            return Math.floor(dt / 86400_000) + 'd ago';
          })();
          const fileNames = e.files.map(f => f.relPath || '?').join(', ');
          const totalHunks = e.files.reduce((s, f) => s + (f.accepted || 0), 0);
          return `<li class="cek-history-item" title="${esc(fileNames)}">
            <div class="cek-history-item-row">
              <span class="cek-history-item-prompt">${esc(e.prompt || '(no prompt)')}</span>
              <button class="btn btn-sm cek-history-item-undo" onclick="cekUndoEntry('${e.id}').then(()=>cekHistoryToggle(event))">↶ Undo</button>
            </div>
            <div class="cek-history-item-meta">${e.files.length} file${e.files.length === 1 ? '' : 's'} · ${totalHunks} hunk${totalHunks === 1 ? '' : 's'} · ${ago}</div>
          </li>`;
        }).join('')}
      </ul>`;
  }
  // Position: anchored under the button, right-aligned to the toolbar's
  // edge so the popover doesn't go off-screen on narrow windows.
  const r = btn.getBoundingClientRect();
  pop.style.position = 'fixed';
  pop.style.top = (r.bottom + 6) + 'px';
  pop.style.left = Math.max(8, Math.min(window.innerWidth - 360, r.left)) + 'px';
  pop.classList.add('show');
  // Outside-click / Esc to close.
  const offClick = (e) => {
    if (pop.contains(e.target) || btn.contains(e.target)) return;
    pop.classList.remove('show');
    document.removeEventListener('mousedown', offClick);
    document.removeEventListener('keydown', offEsc);
  };
  const offEsc = (e) => {
    if (e.key !== 'Escape') return;
    pop.classList.remove('show');
    document.removeEventListener('mousedown', offClick);
    document.removeEventListener('keydown', offEsc);
  };
  setTimeout(() => {
    document.addEventListener('mousedown', offClick);
    document.addEventListener('keydown', offEsc);
  }, 0);
};
window.cekClearHistory = function () {
  if (!confirm('Clear all ⌘K history? Undo data will be lost.')) return;
  _cekHistory = [];
  try { H.set?.('cmdKHistory', '[]'); } catch (_) {}
  cekRefreshToolbar();
  const pop = document.getElementById('cek-history-pop');
  if (pop) pop.classList.remove('show');
};
window.cekUndoEntry = cekUndoEntry; // expose so dropdown onclick works

async function requestDiffPermission({ title='Review changes', description='', before='', after='', language='plaintext' } = {}){
  await initCodeEditor().catch(()=>false);
  if(!window.monaco){
    return await requestPermission({
      eyebrow:'Review diff',
      title,
      description,
      detail:buildDiffPreview(before, after)
    });
  }
  return await new Promise(resolve => {
    const overlay=document.createElement('div');
    overlay.className='diff-overlay';
    overlay.innerHTML=`
      <div class="diff-card">
        <div class="diff-head"><span class="diff-title">${esc(title)}</span><span class="diff-desc">${esc(description)}</span></div>
        <div class="diff-host"></div>
        <div class="diff-actions">
          <button class="perm-btn deny" data-act="deny">Reject</button>
          <button class="perm-btn allow" data-act="allow">Approve</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    let diff = null;
    const cleanup = (value) => {
      try { diff?.dispose?.(); } catch(_){}
      try { overlay.remove(); } catch(_){}
      resolve(value);
    };
    try {
      const host=overlay.querySelector('.diff-host');
      const original=monaco.editor.createModel(String(before ?? ''), language);
      const modified=monaco.editor.createModel(String(after ?? ''), language);
      diff=monaco.editor.createDiffEditor(host,{
        theme:'vs-dark',
        automaticLayout:true,
        renderSideBySide:true,
        minimap:{enabled:false},
        scrollBeyondLastLine:false,
        readOnly:true,
      });
      diff.setModel({ original, modified });
      const oldDispose=diff.dispose.bind(diff);
      diff.dispose=()=>{ try{original.dispose();modified.dispose();}catch(_){} oldDispose(); };
    } catch(_) {
      overlay.querySelector('.diff-host').innerHTML=`<pre class="perm-detail" style="max-height:none;height:100%;box-sizing:border-box">${esc(buildDiffPreview(before,after,160))}</pre>`;
    }
    overlay.querySelector('[data-act="deny"]').onclick=()=>cleanup(false);
    overlay.querySelector('[data-act="allow"]').onclick=()=>cleanup(true);
  });
}

function codeJoin(root, rel=''){
  const sep = root.includes('\\') ? '\\' : '/';
  if (!rel) return root;
  return root.replace(/[\\/]+$/,'') + sep + rel.replace(/^[\\/]+/,'');
}

function codeRelJoin(base, name){
  return [base, name].filter(Boolean).join('/');
}

function codeSetStatus(text, bad=false){
  const el=document.getElementById('code-editor-status');
  if(el){ el.textContent=text; el.style.color=bad?'#fca5a5':'#8d96ab'; }
}

function inferCodeLang(file){
  const ext=(file||'').split('.').pop()?.toLowerCase();
  return ({js:'javascript',jsx:'javascript',ts:'typescript',tsx:'typescript',py:'python',ps1:'powershell',sh:'bash',html:'html',css:'css',json:'json'}[ext]) || 'python';
}

function renderCodeContext(){
  const meta = document.getElementById('code-context-meta');
  if (meta) meta.textContent = codeWorkspace || 'No workspace';
  const title = document.getElementById('code-context-title');
  if (title) {
    const p = prov || provider || 'gemini';
    const m = getSelectedModelForProvider(p) || 'default';
    title.textContent = `${p} · ${m}`;
  }
  // Tools list is hidden in the redesigned IDE shell — keep the data
  // synced anyway so anything reading from #arp-tools-list still sees
  // the current state.
  const tools = document.getElementById('arp-tools-list');
  if (tools) {
    const rows = [
      ['fs.read_file',  codeWorkspace ? 'workspace scope' : 'no workspace'],
      ['fs.write_file', 'permission required'],
      ['fs.search',     codeWorkspace ? 'workspace scope' : 'no workspace'],
      ['shell.exec',    'permission required'],
      ['ai.edit',       `${prov || provider} model`],
    ];
    tools.innerHTML = rows.map(([name, desc]) =>
      `<div class="arp-tool"><div><div class="arp-t-name">${name}</div><div class="arp-t-desc">${desc}</div></div><div class="arp-t-switch on"></div></div>`
    ).join('');
  }
}

// Toggle the bottom terminal pane. Body class controls grid template so the
// editor reclaims the bottom space when the terminal is hidden. Terminal
// stays uninitialised until the user opens it, then initialises lazily.
function toggleCodeTerminal(){
  const wasCollapsed = document.body.classList.contains('code-terminal-collapsed');
  document.body.classList.toggle('code-terminal-collapsed');
  if (wasCollapsed) {
    // We just opened it — make sure the persistent shell is alive.
    initWorkspaceTerminal(false).catch(()=>{});
  }
  // Force Monaco / xterm to re-measure their container after grid resize.
  setTimeout(() => {
    try { codeEditor?.layout?.(); } catch(_){}
    try { window.codeXTermFit?.fit?.(); } catch(_){}
    try { codeTerminal?.fit?.(); } catch(_){}
  }, 80);
}

function toggleCodeChat(){
  const collapsed = !document.body.classList.contains('code-chat-collapsed');
  document.body.classList.toggle('code-chat-collapsed', collapsed);
  const btn = document.getElementById('code-chat-toggle');
  if (btn) btn.classList.toggle('on', !collapsed);
  // PR-LAYOUT-V7 — when user OPENS chat in code-mode (collapsed=false),
  // make sure the .msgs DOM actually has content. The chat column is
  // the same #msgs element used in main chat — messages persist across
  // mode switches. But if there are NO messages yet (fresh session),
  // the floating right column is just an empty black pane (owner's
  // complaint: "должен открываться мини версия чата ... а там все
  // еще просто пятно"). Show greeting + scroll to bottom so the
  // column reads as a working chat surface.
  if (!collapsed) {
    const m = document.getElementById('msgs');
    if (m && !m.children.length) {
      try { showGreeting?.(); } catch(_) {}
    }
    setTimeout(() => {
      try { m.scrollTop = m.scrollHeight; } catch(_) {}
      try { document.getElementById('inp')?.focus(); } catch(_) {}
    }, 60);
  }
  setTimeout(() => {
    try { codeEditor?.layout?.(); } catch(_){}
    try { window.codeXTermFit?.fit?.(); } catch(_){}
    try { codeTerminal?.fit?.(); } catch(_){}
  }, 80);
}

async function chooseCodeWorkspace(){
  const r=await H.wsChooseFolder?.().catch(e=>({ok:false,err:e.message}));
  if(!r?.ok) { codeSetStatus(r?.err || 'Folder selection cancelled.', true); return; }
  codeWorkspace=r.path; codeDir='';
  await refreshCodeWorkspace();
  renderCodeContext();
  await initWorkspaceTerminal(true).catch(()=>{});
  // PR-C4 — refresh git branch chip whenever workspace changes.
  try { refreshGitBranchChip(); } catch (_) {}
}

// ── File tree with lazy expand ───────────────────────────────────────────
// codeTreeNodes[''] holds the root; nested keys are workspace-relative paths.
// Each entry: {loaded: bool, expanded: bool, entries: [{name, isDir, rel}]}.
// Expanding a dir for the first time fetches it and caches. Re-expanding is
// instant. Hidden defaults can be overridden via the wsListIgnore setting
// (array of names to skip).
var codeTreeNodes = {};
var codeTreeIgnore = ['.git','node_modules','dist','build','.next','out','.cache','.idea','.vscode','__pycache__','.venv','venv','target'];

async function _loadCodeTreeDir(rel){
  if (codeTreeNodes[rel]?.loaded) return codeTreeNodes[rel];
  const r = await H.wsList(rel).catch(e=>({ok:false,err:e.message}));
  const node = codeTreeNodes[rel] || { loaded:false, expanded:false, entries:[] };
  node.loaded = true;
  if (r?.ok) {
    const ignoreSet = new Set(codeTreeIgnore);
    node.entries = (r.entries || [])
      .filter(e => !ignoreSet.has(e.name))
      .sort((a,b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name))
      .map(e => ({ name: e.name, isDir: e.isDir, rel: rel ? rel + '/' + e.name : e.name }));
  } else {
    node.entries = [];
    node.error = r?.err || 'Could not read folder.';
  }
  codeTreeNodes[rel] = node;
  return node;
}

async function toggleTreeDir(rel){
  const node = await _loadCodeTreeDir(rel);
  node.expanded = !node.expanded;
  renderCodeTree();
}

function _renderTreeRow(entry, depth){
  const node = codeTreeNodes[entry.rel];
  const expanded = !!(node && node.expanded);
  const indent = `style="padding-left:${8 + depth * 14}px"`;
  if (entry.isDir) {
    const children = expanded && node?.entries?.length
      ? `<div class="tree-children">${node.entries.map(e => _renderTreeRow(e, depth + 1)).join('')}</div>`
      : '';
    const cls = `arp-file dir${expanded ? ' expanded' : ''}`;
    return `<div class="${cls}" ${indent} onclick="toggleTreeDir('${entry.rel.replace(/'/g,"\\'")}')">
      <span class="tree-arrow">▶</span>
      <span class="tree-name">${esc(entry.name)}</span>
    </div>${children}`;
  }
  const active = entry.rel === codeCurrentFile ? ' active' : '';
  return `<div class="arp-file file${active}" ${indent} onclick="openCodeFile('${entry.rel.replace(/'/g,"\\'")}')">
    <span class="tree-arrow"></span>
    <span class="tree-name">${esc(entry.name)}</span>
  </div>`;
}

function renderCodeTree(){
  const list = document.getElementById('arp-files-list');
  if (!list) return;
  const root = codeTreeNodes[''];
  if (!root || !root.entries.length) {
    list.innerHTML = '<div style="color:var(--t3);font-size:11px;line-height:1.6;padding:10px 12px">' +
      (root?.error || 'Empty workspace.') + '</div>';
    return;
  }
  list.innerHTML = root.entries.map(e => _renderTreeRow(e, 0)).join('');
}

async function refreshCodeWorkspace(nextDir){
  // nextDir kept for backward compat — we now ignore it (cd-style nav
  // replaced with persistent tree). If someone passed a path, expand it.
  if(!codeWorkspace) codeWorkspace = await H.get('codeWorkspace').catch(()=> '') || '';
  const status = document.getElementById('code-workspace-status');
  const list = document.getElementById('arp-files-list');
  if(!codeWorkspace){
    const saved = await H.wsGetWorkspace?.().catch(()=>({ok:false,path:''}));
    if(saved?.ok) codeWorkspace = saved.path;
    if(!codeWorkspace){
      if(status) status.textContent = 'No workspace selected yet.';
      if(list) list.innerHTML = '<div style="color:var(--t3);font-size:11px;line-height:1.6;padding:6px 2px">Choose a folder to load files.</div>';
      renderCodeContext();
      return;
    }
  }
  // Restore custom ignore list if persisted.
  try {
    const persistedIgnore = await H.get('wsListIgnore');
    if (Array.isArray(persistedIgnore) && persistedIgnore.length) codeTreeIgnore = persistedIgnore;
  } catch(_){}
  // Wipe cache so we get a fresh root listing; preserves nothing about
  // previously expanded subtrees, but keeps things simple. Re-expansion is
  // a single click + cached IPC.
  codeTreeNodes = {};
  await _loadCodeTreeDir('');
  if (status) status.textContent = codeWorkspace;
  renderCodeTree();
  renderCodeContext();
  initWorkspaceTerminal(false).catch(()=>{});
}

async function searchCodeWorkspace(){
  if(!codeWorkspace){ codeSetStatus('Choose a workspace first.', true); return; }
  const query=(document.getElementById('code-file-search')?.value||'').trim();
  if(!query){ await refreshCodeWorkspace(codeDir); return; }
  const list=document.getElementById('arp-files-list');
  const r=await H.wsSearch(query, codeDir).catch(e=>({ok:false,err:e.message,results:[]}));
  if(!r.ok){ codeSetStatus(r.err || 'Search failed.', true); return; }
  const rows=r.results||[];
  if(list) list.innerHTML = rows.length ? rows.map(item=>{
    const action=item.isDir ? `refreshCodeWorkspace('${item.rel.replace(/'/g,"\\'")}')` : `openCodeFile('${item.rel.replace(/'/g,"\\'")}')`;
    return `<div class="arp-file" onclick="${action}"><span>${esc(item.rel)}</span><span>${esc(item.match || (item.isDir?'dir':'file'))}</span></div>`;
  }).join('') : '<div class="code-status">No matches.</div>';
  codeSetStatus(`Search found ${rows.length} result(s).`);
}

// ── Multi-file tab state ──────────────────────────────────────────────
// Each entry: {rel, language, content, dirty}. content is the snapshot we
// last saved or loaded — we compare against the live editor content to
// surface dirty state. Limit prevents an accidentally-large workspace
// session from chewing memory; oldest non-active tab gets evicted with a
// warning if it's dirty.
var CODE_OPEN_FILES_LIMIT = 8;
var codeOpenFiles = [];
var codeActiveTabIdx = -1;

async function openCodeFile(rel){
  if(!codeWorkspace) return;
  // If the file is already open, just switch to it — don't reload from disk
  // (the user may have unsaved changes).
  const existing = codeOpenFiles.findIndex(f => f.rel === rel);
  if (existing >= 0) {
    await activateCodeTab(existing);
    return;
  }
  const r = await H.wsRead(rel).catch(e=>({ok:false,err:e.message}));
  if(!r.ok){ codeSetStatus(r.err || 'Could not open file.', true); return; }

  // Snapshot current tab's editor content so switching away preserves edits.
  _snapshotActiveTab();

  // Cap open tabs — drop the least-recently-active non-dirty tab if needed.
  if (codeOpenFiles.length >= CODE_OPEN_FILES_LIMIT) {
    const evictIdx = codeOpenFiles.findIndex((f, i) => !f.dirty && i !== codeActiveTabIdx);
    if (evictIdx >= 0) codeOpenFiles.splice(evictIdx, 1);
    else codeSetStatus(`Tab limit reached (${CODE_OPEN_FILES_LIMIT}). Save or close a tab first.`, true);
  }
  codeOpenFiles.push({
    rel,
    language: inferCodeLang(rel),
    content: r.content || '',
    dirty: false,
  });
  codeActiveTabIdx = codeOpenFiles.length - 1;
  await _loadActiveTabIntoEditor();
  renderCodeTabs();
  _persistOpenTabs();
  codeSetStatus(`Opened ${rel}`);
  await refreshCodeWorkspace(codeDir);
}

function _snapshotActiveTab(){
  if (codeActiveTabIdx < 0 || codeActiveTabIdx >= codeOpenFiles.length) return;
  const tab = codeOpenFiles[codeActiveTabIdx];
  if (!tab) return;
  const live = codeGetValue();
  if (live !== tab.content) tab.dirty = true;
  // We don't overwrite tab.content here; tab.content stays the on-disk
  // baseline. Live edits live in the Monaco model, recovered when we
  // re-activate the tab. Simpler than maintaining a per-tab buffer.
}

async function _loadActiveTabIntoEditor(){
  const tab = codeOpenFiles[codeActiveTabIdx];
  if (!tab) {
    codeCurrentFile = '';
    document.getElementById('code-file-path').value = '';
    await initCodeEditor();
    codeSetValue('', 'plaintext');
    return;
  }
  codeCurrentFile = tab.rel;
  document.getElementById('code-file-path').value = codeJoin(codeWorkspace, tab.rel);
  await initCodeEditor();
  // For a freshly-opened tab, content is the on-disk baseline. For a
  // re-activated tab we still load the baseline — Monaco's per-model
  // dirty state would be the next iteration; for now switching tabs
  // discards in-progress edits. Snapshot ensures the user sees the
  // dirty marker so they know.
  codeSetValue(tab.content, tab.language);
}

async function activateCodeTab(idx){
  if (idx < 0 || idx >= codeOpenFiles.length) return;
  if (idx === codeActiveTabIdx) return;
  _snapshotActiveTab();
  codeActiveTabIdx = idx;
  await _loadActiveTabIntoEditor();
  renderCodeTabs();
  _persistOpenTabs();
}

async function closeCodeTab(idx){
  if (idx < 0 || idx >= codeOpenFiles.length) return;
  const tab = codeOpenFiles[idx];
  if (!tab) return;
  if (tab.dirty) {
    const ok = await customConfirm(`"${tab.rel}" has unsaved changes. Close without saving?`);
    if (!ok) return;
  }
  codeOpenFiles.splice(idx, 1);
  if (codeOpenFiles.length === 0) {
    codeActiveTabIdx = -1;
    await _loadActiveTabIntoEditor();
  } else {
    if (codeActiveTabIdx > idx) codeActiveTabIdx--;
    else if (codeActiveTabIdx === idx) codeActiveTabIdx = Math.min(idx, codeOpenFiles.length - 1);
    await _loadActiveTabIntoEditor();
  }
  renderCodeTabs();
  _persistOpenTabs();
}

function renderCodeTabs(){
  const host = document.getElementById('code-tabs');
  if (!host) return;
  if (codeOpenFiles.length === 0) {
    host.innerHTML = '<div class="code-tab-empty">Open a file to start editing</div>';
    return;
  }
  host.innerHTML = codeOpenFiles.map((f, i) => {
    const name = f.rel.split('/').pop();
    const meta = `${(f.content||'').split('\n').length} L · ${f.language}`;
    const dirty = f.dirty ? ' dirty' : '';
    const active = i === codeActiveTabIdx ? ' on' : '';
    return `<div class="code-tab${active}${dirty}" onclick="activateCodeTab(${i})" title="${esc(f.rel)}">
      <span class="code-tab-name">${esc(name)}</span>
      <span class="code-tab-meta">${esc(meta)}</span>
      <button class="code-tab-close" onclick="event.stopPropagation();closeCodeTab(${i})" title="Close">×</button>
    </div>`;
  }).join('');
}

async function _persistOpenTabs(){
  try {
    await H.set('codeOpenFiles', codeOpenFiles.map(f => ({rel: f.rel, language: f.language})));
    await H.set('codeActiveTabIdx', codeActiveTabIdx);
  } catch(_){}
}

async function _restoreOpenTabs(){
  if (!codeWorkspace) return;
  try {
    const saved = await H.get('codeOpenFiles');
    const savedIdx = await H.get('codeActiveTabIdx');
    if (!Array.isArray(saved) || !saved.length) return;
    // Re-read each file from disk so we have fresh content.
    for (const entry of saved.slice(0, CODE_OPEN_FILES_LIMIT)) {
      if (!entry?.rel) continue;
      const r = await H.wsRead(entry.rel).catch(()=>null);
      if (r?.ok) {
        codeOpenFiles.push({
          rel: entry.rel,
          language: entry.language || inferCodeLang(entry.rel),
          content: r.content || '',
          dirty: false,
        });
      }
    }
    if (codeOpenFiles.length) {
      codeActiveTabIdx = Math.min(Math.max(0, Number(savedIdx) || 0), codeOpenFiles.length - 1);
      await _loadActiveTabIntoEditor();
      renderCodeTabs();
    }
  } catch(_){}
}

async function saveCodeFile(){
  if(!codeWorkspace || !codeCurrentFile){ codeSetStatus('Open a file first.', true); return; }
  const before=await H.wsRead(codeCurrentFile).catch(()=>({ok:false,content:''}));
  opLog(`permission write ${codeCurrentFile}`, 'run');
  const newContent = codeGetValue();
  const r=await safeWriteWorkspaceFile(codeCurrentFile, newContent, before?.content || '');
  codeSetStatus(r?.ok ? `Saved ${codeCurrentFile}` : (r?.err || 'Save denied or failed.'), !r?.ok);
  // On successful save, snapshot the new on-disk content into the active tab
  // and clear its dirty marker so the tab indicator reflects reality.
  if (r?.ok) {
    const tab = codeOpenFiles[codeActiveTabIdx];
    if (tab && tab.rel === codeCurrentFile) {
      tab.content = newContent;
      tab.dirty = false;
      renderCodeTabs();
    }
  }
}

async function runCodeSelection(){
  const snap=codeSelectionSnapshot();
  const code=snap.selected || snap.full;
  if(!code.trim()){ codeSetStatus('Nothing to run.', true); return; }
  const run=opStartRun('code', codeCurrentFile || inferCodeLang(codeCurrentFile));
  const r=await safeExecCode(code, inferCodeLang(codeCurrentFile));
  opLog(r?.ok ? (r.out || '(no output)') : (r?.err || 'code failed'), r?.ok?'tool':'error');
  opEndRun(run, r?.ok?'done':'error');
}

async function askCodeAi(kind){
  const snap=codeSelectionSnapshot();
  const selection=snap.selected || snap.full;
  if(!selection.trim()){ codeSetStatus('Open a file or select code first.', true); return; }
  const prompt = kind === 'refactor'
    ? `Refactor this code. Return a clear patch-style explanation and improved code.\nFile: ${codeCurrentFile}\n\n${selection}`
    : kind === 'fix'
      ? `Fix bugs in this code. Return a short explanation and one complete corrected code block.\nFile: ${codeCurrentFile}\n\n${selection}`
    : `Explain this code clearly and point out risks or bugs.\nFile: ${codeCurrentFile}\n\n${selection}`;
  const run=opStartRun('ai.code', `${kind} ${codeCurrentFile || ''}`);
  const res=await H.ai([{role:'user',content:prompt}], prov, null, aiOptsForProvider(prov)).catch(e=>({error:e.message}));
  if(res.error){ opLog(res.error,'error'); codeSetStatus(res.error,true); opEndRun(run,'error'); return; }
  addMsg('bot', res.reply, {model:res.model||prov});
  trackTokens(res.reply,'assistant',prov,res.usage);
  if(kind !== 'explain'){
    const replacement = extractCodeFence(res.reply);
    if(replacement){
      codeLastAiPatch = { replacement, snapshot:snap, file:codeCurrentFile, kind };
      codeSetStatus(`AI ${kind} ready. Use Apply AI to edit the buffer, then Save to write.`);
    } else {
      codeSetStatus(`AI ${kind} finished, but no code block was found to apply.`, true);
    }
  }
  opLog(`ai.code ${kind} complete`, 'tool');
  opEndRun(run,'done');
}

async function applyLastCodeAi(){
  if(!codeLastAiPatch?.replacement){ codeSetStatus('No AI patch ready.', true); return; }
  const before = codeGetValue();
  const after = codeLastAiPatch.snapshot?.hasSelection
    ? before
    : codeLastAiPatch.replacement;
  const ok = await requestDiffPermission({
    title: codeLastAiPatch.file || 'current buffer',
    description: 'This updates the editor buffer only. Use Save to write the file.',
    before,
    after: codeLastAiPatch.snapshot?.hasSelection ? `${before}\n\n/* Selected range will be replaced with: */\n${codeLastAiPatch.replacement}` : after,
    language: inferCodeLang(codeLastAiPatch.file || codeCurrentFile)
  });
  if(!ok){ codeSetStatus('AI patch not applied.', true); return; }
  codeReplaceSnapshot(codeLastAiPatch.snapshot, codeLastAiPatch.replacement);
  codeSetStatus('AI patch applied to editor buffer. Review, then Save.');
}

async function runWorkspaceCommand(){
  const input=document.getElementById('code-terminal-command');
  const out=document.getElementById('code-terminal-output');
  const cmd=(input?.value||'').trim();
  if(!cmd){ codeSetStatus('Enter a command first.', true); return; }
  if(!codeWorkspace){ codeSetStatus('Choose a workspace first.', true); return; }
  if(codeTerminalId && codeTerminal){
    await H.terminalWrite?.(codeTerminalId, `${cmd}\r`).catch(e=>appendTerminalFallback(`\n${e.message}\n`));
    if(input) input.value='';
    return;
  }
  const run=opStartRun('workspace.shell', cmd);
  if(out) out.textContent += `\n$ ${cmd}\n`;
  const r=await safeWorkspaceShell(cmd);
  if(out) out.textContent += (r?.ok ? (r.out || '(no output)') : (r?.err || 'command failed')) + '\n';
  opLog(r?.ok ? `workspace command ok: ${cmd}` : `workspace command failed: ${cmd}`, r?.ok?'tool':'error');
  opEndRun(run, r?.ok?'done':'error');
}

function updateOperatorStepPanel(step){
  if(!activeAgentPanelSteps) return;
  if(step.type === 'executing'){
    activeAgentPanelSteps.push({ id:step.stepId, runId:step.runId, tool:step.tool, args:step.args, reason:step.reason, result:null });
  } else if(step.type === 'result'){
    const target = activeAgentPanelSteps.find(s=>s.id && s.id===step.stepId) || activeAgentPanelSteps[activeAgentPanelSteps.length - 1];
    if(target) target.result = step.result;
  } else if(step.type === 'denied' || step.type === 'stopped'){
    activeAgentPanelSteps.push({ id:step.stepId, runId:step.runId, tool:step.tool, args:step.args, reason:step.reason || step.error, result:{ok:false,error:step.error || step.reason || step.type} });
  }
  activeAgentPanelRef = renderAgentPanel(activeAgentPanelSteps, null, true);
}

function handleOperatorAgentStep(step){
  if(!step) return;
  if(step.type === 'run-start'){
    operatorCurrentAgentRunId = step.runId || operatorCurrentAgentRunId;
    operatorWaitingStepId = '';
    operatorPaused = false;
    operatorStopRequested = false;
    opLog(`agent run started ${step.runId || ''} (${step.provider || ''}/${step.model || 'default'})`, 'run');
    opLoadRuns().catch(()=>{});
    opRefresh();
    return;
  }
  if(step.type === 'control'){
    operatorCurrentAgentRunId = step.runId || operatorCurrentAgentRunId;
    operatorPaused = step.action === 'pause' || step.status === 'paused' || step.action === 'step';
    if(step.action === 'resume') operatorPaused = false;
    if(step.action === 'stop'){
      operatorPaused = false;
      operatorWaitingStepId = '';
    }
    if(step.currentStepId) operatorWaitingStepId = step.currentStepId;
    opLog(`control ${step.action || ''} ${step.status || ''}`, step.action === 'stop' ? 'error' : 'run');
    opRefresh();
    return;
  }
  if(step.type === 'waiting'){
    operatorCurrentAgentRunId = step.runId || operatorCurrentAgentRunId;
    operatorWaitingStepId = step.stepId || '';
    operatorPaused = Boolean(step.paused || operatorPaused);
    const perm = step.permission || {};
    const label = perm.required && !perm.allowed ? 'permission required' : 'waiting';
    opLog(`${label} before ${step.tool || 'tool'} ${step.stepId || ''}${perm.operation ? ' · ' + perm.operation : ''}`, perm.required && !perm.allowed ? 'error' : 'run');
    opRefresh();
    return;
  }
  if(step.type === 'executing'){
    operatorCurrentAgentRunId = step.runId || operatorCurrentAgentRunId;
    if(step.stepId && step.stepId === operatorWaitingStepId) operatorWaitingStepId = '';
    opLog(`tool executing ${step.tool || ''} ${step.reason || ''}`, 'tool');
    updateOperatorStepPanel(step);
    opRefresh();
    return;
  }
  if(step.type === 'result'){
    if(step.stepId && step.stepId === operatorWaitingStepId) operatorWaitingStepId = '';
    opLog(`tool result ${step.tool || ''}`, 'tool');
    updateOperatorStepPanel(step);
    opRefresh();
    return;
  }
  if(step.type === 'denied' || step.type === 'stopped'){
    if(step.stepId && step.stepId === operatorWaitingStepId) operatorWaitingStepId = '';
    opLog(`${step.type} ${step.tool || ''} ${step.reason || step.error || ''}`, step.type === 'stopped' ? 'error' : 'run');
    updateOperatorStepPanel(step);
    opRefresh();
    return;
  }
  if(step.type === 'run-end'){
    if(!step.runId || step.runId === operatorCurrentAgentRunId){
      operatorCurrentAgentRunId = '';
      operatorWaitingStepId = '';
      operatorPaused = false;
    }
    opLog(`agent run ${step.status || 'ended'} ${step.runId || ''}`, step.status === 'error' ? 'error' : 'run');
    opLoadRuns().catch(()=>{});
    opRefresh();
    return;
  }
  opLog(`agent ${step.type || 'step'} ${step.tool || ''} ${step.reason || ''}`, 'tool');
}

function ensureOperatorAgentListener(){
  if(operatorAgentListenerInstalled || !H.onAgentStep) return;
  try {
    H.onAgentStep((step)=>handleOperatorAgentStep(step));
    operatorAgentListenerInstalled = true;
  } catch(_) {}
}

function opStartRun(kind, label){
  const id='run-'+(++opSeq);
  operatorStopRequested = false;
  operatorRuns.set(id,{id,kind,label,status:'running',started:Date.now()});
  opLog(`${kind} started: ${label || ''}`, 'run');
  opRefresh();
  return id;
}
function opEndRun(id,status='done'){
  const r=operatorRuns.get(id); if(!r) return;
  if(r.status==='stopped') { opLog(`${r.kind} finished after stop request`, 'run'); opRefresh(); return; }
  r.status=status; r.ended=Date.now();
  opLog(`${r.kind} ${status} (${Math.round((r.ended-r.started)/1000)}s)`, status==='error'?'error':'run');
  opRefresh();
}
function opRefresh(){
  const localActive=[...operatorRuns.values()].filter(r=>r.status==='running').length;
  const remoteActive=operatorRunHistory.filter(r=>r.status==='running').length;
  const active=Math.max(localActive, remoteActive, operatorCurrentAgentRunId ? 1 : 0);
  const el=document.getElementById('op-active-runs');
  if(el) el.textContent=`Active Runs: ${active}`;
  const pauseBtn=document.getElementById('op-pause-btn');
  if(pauseBtn) pauseBtn.textContent=operatorPaused ? 'Resume' : 'Pause';
  opRender();
}
function opClear(){ operatorLogLines=[]; opPersistLogForCurrentChat().catch(()=>{}); opRender(); }
async function opCopy(){
  // Copy log as a structured JSON payload — easier to paste into a bug
  // report / share with another developer than the rendered DOM text.
  try {
    const payload = {
      exportedAt: new Date().toISOString(),
      tab: operatorTab,
      provider: prov || provider,
      model: getSelectedModelForProvider(prov || provider) || null,
      activeRunId: operatorCurrentAgentRunId || null,
      paused: operatorPaused,
      lines: (operatorLogLines || []).map(l => ({
        time: l.time,
        type: l.type,
        msg: l.msg,
      })),
      runs: [...operatorRuns.values()].map(r => ({
        id: r.id, kind: r.kind, label: r.label, status: r.status,
        startedAt: r.started ? new Date(r.started).toISOString() : null,
        endedAt:   r.ended   ? new Date(r.ended).toISOString()   : null,
        durationMs: r.ended && r.started ? (r.ended - r.started) : null,
      })),
    };
    await H.copy(JSON.stringify(payload, null, 2));
    opLog('log copied as JSON', 'tool');
  } catch(_) {
    // Fallback to plain-text copy if JSON serialise fails for any reason.
    try { await H.copy(document.getElementById('op-log')?.innerText || ''); } catch(__){}
  }
}
function opTab(tab){
  operatorTab=tab;
  ['log','tools','runs'].forEach(t=>document.getElementById(`op-tab-${t}`)?.classList.toggle('on', t===tab));
  if(tab==='runs') opLoadRuns().catch(e=>opLog(`runs load failed: ${e.message}`, 'error'));
  opRender();
}
async function opPause(){
  if(!operatorCurrentAgentRunId){ opLog('no active agent run to pause', 'error'); return; }
  const action=operatorPaused ? 'resume' : 'pause';
  const r=await H.agentControl?.(operatorCurrentAgentRunId, action).catch(e=>({ok:false,error:e.message}));
  if(!r?.ok){ opLog(r?.error || `${action} failed`, 'error'); return; }
  operatorPaused = action === 'pause';
  if(!operatorPaused) operatorWaitingStepId = '';
  opLog(operatorPaused ? 'agent pause armed before next tool' : 'agent resumed', 'run');
  opRefresh();
}
async function opStep(){
  if(operatorWaitingStepId){
    const r=await H.agentStep?.(operatorWaitingStepId,{decision:'allow_once',reason:'operator step'}).catch(e=>({ok:false,error:e.message}));
    if(!r?.ok){ opLog(r?.error || 'step failed', 'error'); return; }
    opLog(`step allowed ${operatorWaitingStepId}`, 'run');
    operatorWaitingStepId='';
    operatorPaused=true;
    opRefresh();
    return;
  }
  if(!operatorCurrentAgentRunId){ opLog('no active agent run to step', 'error'); return; }
  const r=await H.agentControl?.(operatorCurrentAgentRunId,'step').catch(e=>({ok:false,error:e.message}));
  if(!r?.ok){ opLog(r?.error || 'step failed', 'error'); return; }
  operatorPaused=true;
  opLog('next tool will run as a single step', 'run');
  opRefresh();
}
async function opStop(){
  operatorStopRequested=true;
  if(operatorWaitingStepId){
    await H.agentStep?.(operatorWaitingStepId,{decision:'stop',reason:'operator stop'}).catch(()=>{});
    operatorWaitingStepId='';
  }
  if(operatorCurrentAgentRunId){
    const r=await H.agentControl?.(operatorCurrentAgentRunId,'stop').catch(e=>({ok:false,error:e.message}));
    if(!r?.ok) opLog(r?.error || 'stop failed', 'error');
  }
  for(const r of operatorRuns.values()){
    if(r.status==='running'){ r.status='stopped'; r.ended=Date.now(); }
  }
  operatorPaused=false;
  opLog('stop requested for active runs', 'error');
  opRefresh();
}
async function opLoadRuns(){
  const r=await H.agentRuns?.(50);
  if(!r?.ok) throw new Error(r?.error || 'Could not load runs');
  if(!operatorCurrentAgentRunId && r.active?.[0]?.id) operatorCurrentAgentRunId = r.active[0].id;
  if(operatorCurrentAgentRunId && !(r.active||[]).some(run=>run.id===operatorCurrentAgentRunId)) operatorCurrentAgentRunId = '';
  const seen=new Set();
  operatorRunHistory=[...(r.active||[]),...(r.history||[])].filter(run=>{
    if(!run?.id || seen.has(run.id)) return false;
    seen.add(run.id);
    return true;
  });
  if(operatorTab==='runs') opRender();
}
async function opShowRunJson(id){
  const r=await H.agentRunDetails?.(id).catch(e=>({ok:false,error:e.message}));
  if(!r?.ok){ opLog(r?.error || 'Could not load run JSON', 'error'); return; }
  operatorRunJson=r.run || {};
  operatorTab='json';
  ['log','tools','runs'].forEach(t=>document.getElementById(`op-tab-${t}`)?.classList.toggle('on', false));
  opRender();
}
function opBackToRuns(){
  operatorTab='runs';
  operatorRunJson=null;
  ['log','tools','runs'].forEach(t=>document.getElementById(`op-tab-${t}`)?.classList.toggle('on', t==='runs'));
  opRender();
}
function opRender(){
  const log=document.getElementById('op-log');
  if(!log) return;
  if(operatorTab==='tools'){
    const rows=[
      ['provider', prov || provider || 'unset'],
      ['model', getSelectedModelForProvider(prov || provider) || 'default'],
      ['workspace', codeWorkspace || 'not selected'],
      ['permission gate', permissionGateEnabled ? 'enabled' : 'disabled'],
      ['paused', operatorPaused ? 'yes' : 'no'],
      ['active run', operatorCurrentAgentRunId || 'none'],
      ['waiting step', operatorWaitingStepId || 'none'],
    ];
    log.innerHTML=rows.map(([k,v])=>`<div class="op-log-line tool"><b>${esc(k)}</b> · ${esc(String(v))}</div>`).join('');
    return;
  }
  if(operatorTab==='runs'){
    const localRows=[...operatorRuns.values()].reverse().map(r=>({source:'ui',...r}));
    const remoteRows=operatorRunHistory.map(r=>({source:'agent',...r}));
    const rows=[...remoteRows,...localRows];
    log.innerHTML=rows.length ? rows.map(r=>{
      const started=r.started || (r.startedAt ? Date.parse(r.startedAt) : Date.now());
      const ended=r.ended || (r.endedAt ? Date.parse(r.endedAt) : Date.now());
      const label=r.label || r.prompt || r.model || '';
      const stepInfo=r.currentTool ? ` - waiting ${r.currentTool}` : (r.stepCount ? ` - ${r.stepCount} steps` : '');
      const click=r.source==='agent' ? ` onclick="opShowRunJson('${String(r.id).replace(/'/g,"\\'")}')"` : '';
      return `<div class="op-log-line run"${click} style="${r.source==='agent'?'cursor:pointer':''}"><b>${esc(r.status||'unknown')}</b> - ${esc(r.source)} - ${esc(r.kind||r.provider||'agent')} - ${esc(String(label).slice(0,90))}${esc(stepInfo)} - ${Math.max(0,Math.round((ended-started)/1000))}s</div>`;
    }).join('') : '<div class="op-log-line tool">No runs yet.</div>';
    return;
  }
  if(false && operatorTab==='runs'){
    const rows=[...operatorRuns.values()].reverse();
    log.innerHTML=rows.length ? rows.map(r=>{
      const end=r.ended || Date.now();
      return `<div class="op-log-line run"><b>${esc(r.status)}</b> · ${esc(r.kind)} · ${esc(r.label||'')} · ${Math.round((end-r.started)/1000)}s</div>`;
    }).join('') : '<div class="op-log-line tool">No runs yet.</div>';
    return;
  }
  if(operatorTab==='json'){
    const json=JSON.stringify(operatorRunJson || {}, null, 2);
    log.innerHTML=`<div class="op-log-line run"><button class="op-btn" onclick="opBackToRuns()">Back to runs</button></div><pre class="op-log-line tool" style="white-space:pre-wrap;line-height:1.5">${esc(json)}</pre>`;
    return;
  }
  log.innerHTML=operatorLogLines.slice(-200).map(l=>`<div class="op-log-line ${l.type}">[${esc(l.time)}] ${esc(l.msg)}</div>`).join('');
  log.scrollTop=log.scrollHeight;
}

function toggleCodeMode() {
  const next = !codeModeActive;
  if (next) {
    setActiveSurface('code');
    codeModeActive = true;
    document.body.classList.add('code-mode-active');
    document.body.classList.add('code-chat-collapsed');
    // Start with the bottom terminal collapsed — the editor wants the room
    // and most users open the terminal on demand. They can open it via the
    // ⌨ Terminal button in the top bar.
    document.body.classList.add('code-terminal-collapsed');
    document.getElementById('code-mode-btn').classList.add('proc');
    // Render the (possibly empty) tab strip immediately so the editor area
    // looks complete instead of blank above Monaco.
    renderCodeTabs();
    initCodeEditor().then(() => {
      // Monaco needs a layout pass after its container resizes from the
      // grid expansion, otherwise it draws at the old 360px width.
      try { codeEditor?.layout?.(); } catch(_){}
    }).catch(()=>{});
    refreshCodeWorkspace().then(() => {
      // Once the workspace is loaded, restore the previously-open tabs.
      if (codeOpenFiles.length === 0) _restoreOpenTabs().catch(()=>{});
    }).catch(()=>{});
    renderCodeContext();
  } else {
    closeActiveSurface();
  }
}

// Code Mode keyboard shortcuts. Active only while body.code-mode-active so
// they don't fight the chat keybinds. Ctrl+W closes the active tab,
// Ctrl+Tab cycles forward (Shift+Ctrl+Tab cycles back), Ctrl+P opens the
// fuzzy file finder.
document.addEventListener('keydown', (e) => {
  if (!document.body.classList.contains('code-mode-active')) return;
  const ctrl = e.ctrlKey || e.metaKey;
  // Ctrl+P always opens quick-find regardless of focus target — that's
  // the muscle memory from VS Code / Cursor.
  if (ctrl && (e.key === 'p' || e.key === 'P') && !e.shiftKey) {
    e.preventDefault();
    openQuickOpen();
    return;
  }
  // Ignore tab-management hotkeys when focus is in a chat input/textarea
  // (Monaco handles its own keybinds — Ctrl+W there is fine to intercept).
  const tag = e.target?.tagName;
  const inMonaco = e.target?.closest?.('.code-monaco');
  if (!inMonaco && (tag === 'INPUT' || tag === 'TEXTAREA')) return;
  if (ctrl && (e.key === 'w' || e.key === 'W')) {
    if (codeOpenFiles.length === 0) return;
    e.preventDefault();
    closeCodeTab(codeActiveTabIdx);
  } else if (ctrl && e.key === 'Tab') {
    if (codeOpenFiles.length < 2) return;
    e.preventDefault();
    const dir = e.shiftKey ? -1 : 1;
    const next = (codeActiveTabIdx + dir + codeOpenFiles.length) % codeOpenFiles.length;
    activateCodeTab(next);
  }
});

// ── Quick file open (Ctrl+P) ────────────────────────────────────────────
var _qoSelected = 0;
var _qoLastQuery = '';
var _qoTimer = null;

function openQuickOpen(){
  if (!codeWorkspace) {
    codeSetStatus('Open a folder first.', true);
    return;
  }
  document.getElementById('quickopen-palette').classList.add('show');
  const input = document.getElementById('quickopen-input');
  if (input) { input.value = ''; setTimeout(() => input.focus(), 30); }
  filterQuickOpen('');
}

function closeQuickOpen(){
  document.getElementById('quickopen-palette').classList.remove('show');
}

function filterQuickOpen(query){
  query = (query || '').trim();
  _qoLastQuery = query;
  if (_qoTimer) clearTimeout(_qoTimer);
  const results = document.getElementById('quickopen-results');
  if (!results) return;
  if (!query) {
    // Show currently-open tabs as a starting list, then files cached from
    // the visible tree. Saves a backend hit when the user just wants to
    // jump between things they've already touched.
    const seen = new Set();
    const items = [];
    for (const f of codeOpenFiles) {
      if (!seen.has(f.rel)) { seen.add(f.rel); items.push({rel:f.rel, hint:'open'}); }
    }
    for (const path in codeTreeNodes) {
      for (const e of (codeTreeNodes[path]?.entries || [])) {
        if (!e.isDir && !seen.has(e.rel)) { seen.add(e.rel); items.push({rel:e.rel, hint:''}); if (items.length >= 30) break; }
      }
      if (items.length >= 30) break;
    }
    if (!items.length) {
      results.innerHTML = '<div class="cmd-item" style="cursor:default;color:var(--t3);font-style:italic">Type to search files in workspace…</div>';
      return;
    }
    results.innerHTML = items.map((it, i) => `
      <div class="cmd-item${i===0?' active':''}" data-rel="${esc(it.rel)}" onclick="quickOpenSelect(this.dataset.rel)">
        <span class="cmd-item-icon"><svg class="licon"><use href="#i-file-text"/></svg></span>
        <span class="cmd-item-text">${esc(it.rel)}</span>
        <span class="cmd-item-hint">${esc(it.hint)}</span>
      </div>`).join('');
    _qoSelected = 0;
    return;
  }
  // Debounce server search by 120ms so fast typing doesn't fan out.
  _qoTimer = setTimeout(async () => {
    if (query !== _qoLastQuery) return;
    const r = await H.wsSearch(query, '').catch(e => ({ok:false,err:e.message,results:[]}));
    if (!r?.ok) {
      results.innerHTML = `<div class="cmd-item" style="cursor:default;color:var(--red)">${esc(r?.err || 'Search failed')}</div>`;
      return;
    }
    const files = (r.results || []).filter(it => !it.isDir).slice(0, 50);
    if (!files.length) {
      results.innerHTML = '<div class="cmd-item" style="cursor:default;color:var(--t3);font-style:italic">No matches</div>';
      return;
    }
    results.innerHTML = files.map((f, i) => `
      <div class="cmd-item${i===0?' active':''}" data-rel="${esc(f.rel)}" onclick="quickOpenSelect(this.dataset.rel)">
        <span class="cmd-item-icon"><svg class="licon"><use href="#i-file-text"/></svg></span>
        <span class="cmd-item-text">${esc(f.rel)}</span>
        <span class="cmd-item-hint">${esc(f.match || '')}</span>
      </div>`).join('');
    _qoSelected = 0;
  }, 120);
}

function quickOpenKeyDown(e){
  const items = document.querySelectorAll('#quickopen-results .cmd-item[data-rel]');
  if (e.key === 'Escape') { e.preventDefault(); closeQuickOpen(); return; }
  if (e.key === 'ArrowDown' && items.length) {
    e.preventDefault();
    _qoSelected = Math.min(_qoSelected + 1, items.length - 1);
    _updateQOSelection();
  } else if (e.key === 'ArrowUp' && items.length) {
    e.preventDefault();
    _qoSelected = Math.max(_qoSelected - 1, 0);
    _updateQOSelection();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const target = items[_qoSelected];
    if (target?.dataset?.rel) quickOpenSelect(target.dataset.rel);
  }
}

function _updateQOSelection(){
  const items = document.querySelectorAll('#quickopen-results .cmd-item[data-rel]');
  items.forEach((el, i) => el.classList.toggle('active', i === _qoSelected));
  items[_qoSelected]?.scrollIntoView({block:'nearest'});
}

async function quickOpenSelect(rel){
  closeQuickOpen();
  if (rel) await openCodeFile(rel);
}

// ═══════════════════════════════════════════════════════════════
// OPERATOR CONSOLE — toggleOperatorMode + opLog + console hooks
// ═══════════════════════════════════════════════════════════════
// PR-V Phase 3.15 — moved here from chat.html inline (was lines
// 4951-4966 + 5262-5275 of pre-extraction file). All other operator
// functions (opStartRun, opEndRun, opRefresh, opPause, opStep, opStop,
// opTab, opLoadRuns, opShowRunJson, opBackToRuns, opRender,
// ensureOperatorAgentListener, handleOperatorAgentStep) already lived
// in this file from Phase 3.14 — they were physically interleaved
// with code-workspace state. Now toggleOperatorMode + opLog +
// console.log/error overrides join them.
//
// opLog needs to be defined here because ensureOperatorAgentListener
// (also here) calls opLog when forwarding agent steps.

var operatorModeActive = false;
function toggleOperatorMode() {
  operatorModeActive = !operatorModeActive;
  if (operatorModeActive) {
    if (activeSurface !== 'chat' && activeSurface !== 'code') closeActiveSurface();
    document.body.classList.add('operator-mode-active');
    document.getElementById('operator-mode-btn').classList.add('proc');
    ensureOperatorAgentListener();
    loadOperatorLogForCurrentChat().catch(()=>{});
    opLoadRuns().catch(()=>{});
    opRefresh();
  } else {
    document.body.classList.remove('operator-mode-active');
    document.getElementById('operator-mode-btn').classList.remove('proc');
  }
  updateShellChrome('chat');
}

function opLog(msg, type='info') {
  const chatId = (typeof currentChatId !== 'undefined' && currentChatId) ? currentChatId : operatorLogChatId;
  if (chatId && operatorLogChatId !== chatId) {
    operatorLogChatId = chatId;
  }
  operatorLogLines.push({time:new Date().toLocaleTimeString(), msg:String(msg), type, chatId: operatorLogChatId || null});
  opSchedulePersistLogForCurrentChat();
  opRender();
  try { if (inspectorTab === 'log') refreshInspectorLog(); } catch (_) {}
}
var origLog = console.log;
console.log = function(...args) {
  origLog.apply(console, args);
  if(operatorModeActive) opLog(args.join(' '));
};
var origError = console.error;
console.error = function(...args) {
  origError.apply(console, args);
  if(operatorModeActive) opLog(args.join(' '), 'error');
};

