// PR-V Phase 3.21 — Slash commands + @-mention autocomplete.
// Extracted from chat.html inline <script> (was lines 3026-3315).
//
// Two coupled input-field decorators:
//
//   1. Slash commands (PR-C1): /foo → dropdown with matching
//      commands (/help, /clear, /new, /persona, /model, /code,
//      /agent, /chat, /settings).
//
//   2. @ mention (PR-D2): @symbol or @file → autocomplete dropdown
//      that pulls from workspace via H.wsList / H.wsSearch and
//      inserts "FILE: path" or "SYMBOL: name" tokens into the
//      input.
//
// Both attach to the input textarea via the central kd() handler
// in main inline (which delegates to slashKeyDown / atMentionKeyDown
// when the respective dropdown is open).
//
// State:
//   SLASH_COMMANDS — static list of slash commands
//   _slashState — {items, activeIdx, inputEl, query} when open
//   _AT_MENTION_TYPES — supported mention kinds (symbol/file)
//   _atMentionState — {kind, query, items, activeIdx} when open
//
// Loaded as external script AFTER main inline so window.* globals
// it reads (H IPC, clearHist, createNewChat, setMode, setPersona,
// saveModelSetting, openPanel, ar, addMsg, etc.) are defined.

// ═══ PR-C1 — Slash commands ═══════════════════════════════════════════
// Type `/foo` at the start of the chat input → autocomplete dropdown
// with matching commands. Tab/Enter executes; Esc closes. Each command
// is { id, label, hint, exec(arg) }. Designed to mirror Claude Code /
// Cursor / ChatGPT-codex slash conventions.
var SLASH_COMMANDS = [
  // ── Core conversation control ───────────────────────────────────────
  { id: 'help',     label: '/help',           hint: 'Show all slash commands',                           exec: () => slashShowHelp() },
  { id: 'new',      label: '/new',            hint: 'Start a new chat',                                 exec: () => { try { createNewChat?.(); } catch(_){} } },
  { id: 'clear',    label: '/clear',          hint: 'Clear current chat history (memory retained)',     exec: () => { try { clearHist?.(); } catch(_){} } },
  { id: 'reset',    label: '/reset',          hint: 'Reset transcript (alias of /clear)',               exec: () => { try { clearHist?.(); } catch(_){} } },
  { id: 'export',   label: '/export',         hint: 'Export current chat to .md / .json',               exec: () => { try { window._handleSlashCommand?.('/export'); } catch(_){} } },
  { id: 'find',     label: '/find <query>',   hint: 'Find text in transcript (also Ctrl+F)',            exec: (arg) => { try { window._handleSlashCommand?.('/find ' + (arg || '')); } catch(_){} } },

  // ── Provider / persona / mode ───────────────────────────────────────
  { id: 'persona',  label: '/persona <id>',   hint: 'Switch persona (jarvis|friday|alfred|sage|pixel)', exec: (arg) => { try { setPersona?.(arg || 'jarvis'); } catch(_){} } },
  { id: 'model',    label: '/model <name>',   hint: 'Switch active provider model',                     exec: (arg) => { try { saveModelSetting?.(prov, arg); } catch(_){} } },
  { id: 'provider', label: '/provider <id>',  hint: 'Switch AI provider (claude|openai|gemini|...)',    exec: (arg) => { try { window._handleSlashCommand?.('/provider ' + (arg || '')); } catch(_){} } },
  { id: 'lang',     label: '/lang <id>',      hint: 'Switch language (en|ru)',                          exec: (arg) => { try { window._handleSlashCommand?.('/lang ' + (arg || '')); } catch(_){} } },
  { id: 'mode',     label: '/mode <name>',    hint: 'Switch chat mode (chat|code|agent|vision|...)',    exec: (arg) => { try { setMode?.(arg || 'chat'); } catch(_){} } },
  { id: 'chat',     label: '/chat',           hint: 'Switch to plain chat mode',                        exec: () => { try { setMode?.('chat'); } catch(_){} } },
  { id: 'agent',    label: '/agent',          hint: 'Switch to Agent mode',                             exec: () => { try { setMode?.('agent'); } catch(_){} } },
  { id: 'code',     label: '/code',           hint: 'Open Code Mode IDE',                               exec: () => { try { toggleCodeMode?.(); } catch(_){} } },
  { id: 'vision',   label: '/vision',         hint: 'Switch to Vision mode (screen analysis)',          exec: () => { try { setMode?.('vision'); } catch(_){} } },

  // ── Toggles ─────────────────────────────────────────────────────────
  { id: 'voice',    label: '/voice',          hint: 'Toggle voice (TTS) on/off',                        exec: () => { try { togSw?.('tts','sw-tts'); } catch(_){} } },
  { id: 'wake',     label: '/wake',           hint: 'Toggle wake-word on/off',                          exec: () => { try { document.getElementById('tc-wake')?.click(); } catch(_){} } },
  { id: 'talk',     label: '/talk',           hint: 'Toggle continuous Talk Mode on/off',               exec: () => { try { window._handleSlashCommand?.('/talk'); } catch(_){} } },
  { id: 'eye',      label: '/eye',            hint: 'Toggle screen-watcher on/off',                     exec: () => { try { togSw?.('screenWatcher','sw-eye'); } catch(_){} } },
  { id: 'theme',    label: '/theme <id>',     hint: 'Switch theme (dark|light|auto)',                   exec: (arg) => { try { window._handleSlashCommand?.('/theme ' + (arg || '')); } catch(_){} } },

  // ── Panels & hubs ───────────────────────────────────────────────────
  { id: 'settings', label: '/settings [tab]', hint: 'Open settings panel (account|models|providers|…)', exec: (arg) => { try { openPanel?.(arg || ''); } catch(_){} } },
  { id: 'workflows',label: '/workflows',      hint: 'Open Workflows panel',                             exec: () => { try { openWorkflows?.(); } catch(_){} } },
  { id: 'plugins',  label: '/plugins',        hint: 'Open Plugin Hub',                                  exec: () => { try { openHub?.(); } catch(_){} } },
  { id: 'store',    label: '/store',          hint: 'Open Marketplace',                                 exec: () => { try { openStore?.(); } catch(_){} } },
  { id: 'palette',  label: '/palette',        hint: 'Open command palette (⌘K)',                        exec: () => { try { openCmdPalette?.(); } catch(_){} } },
  { id: 'telegram', label: '/telegram',       hint: 'Open Telegram chat viewer',                        exec: () => { try { openTelegramHub?.(); } catch(_){} } },
  { id: 'discord',  label: '/discord',        hint: 'Open Discord chat viewer',                         exec: () => { try { window._handleSlashCommand?.('/discord'); } catch(_){} } },
  { id: 'canvas',   label: '/canvas',         hint: 'Open Live Canvas — shared editable surface with the agent (Phase 26 MVP)', exec: () => { try { window.toggleCanvas?.(); } catch(_){} } },

  // ── Skills ──────────────────────────────────────────────────────────
  { id: 'skills',   label: '/skills',         hint: 'Open Skill Hub (browse / edit / toggle SKILL.md)', exec: () => { try { openSkillHub?.(); } catch(_){} } },
  { id: 'skill',    label: '/skill <id> [message]', hint: 'Force-load a skill on the next turn',       exec: (arg) => { try { window._handleSlashCommand?.('/skill ' + (arg || '')); } catch(_){} } },

  // ── Subagents (parallel-friendly research / multi-source lookups) ──
  { id: 'spawn_subagent', label: '/spawn_subagent <task>', hint: 'Fire a one-off subagent — bypasses the AI loop. Test mode.', exec: (arg) => { try { window._handleSlashCommand?.('/spawn_subagent ' + (arg || '')); } catch(_){} } },
  { id: 'subagent', label: '/subagent <task>', hint: 'Alias for /spawn_subagent — see Subagents inspector tab.',          exec: (arg) => { try { window._handleSlashCommand?.('/subagent ' + (arg || '')); } catch(_){} } },

  // ── Memory + tools ──────────────────────────────────────────────────
  { id: 'mem',      label: '/mem <query>',    hint: 'Semantic memory search',                           exec: (arg) => { try { window._handleSlashCommand?.('/mem ' + (arg || '')); } catch(_){} } },
  { id: 'cron',     label: '/cron <expr> <task>', hint: 'Create a scheduled task',                      exec: (arg) => { try { window._handleSlashCommand?.('/cron ' + (arg || '')); } catch(_){} } },
  { id: 'docs',     label: '/docs',           hint: 'Open the docs in your browser',                    exec: () => { try { window.H?.openExternal?.('https://horizonaai.dev/docs/quick-start'); } catch(_){} } },
  { id: 'doctor',   label: '/doctor',         hint: 'Run health check + auto-fix',                      exec: () => { try { window._handleSlashCommand?.('/doctor'); } catch(_){} } },
  { id: 'reload',   label: '/reload',         hint: 'Reload the renderer (Ctrl+R alternative)',         exec: () => { try { window.location.reload(); } catch(_){} } },
  { id: 'quit',     label: '/quit',           hint: 'Quit Horizon',                                     exec: () => { try { window.H?.quit?.(); } catch(_){} } },
];
var _slashState = null; // { items, activeIdx, inputEl, query } when open

function slashMaybeOpen(inputEl) {
  if (!inputEl) return;
  const value = inputEl.value || '';
  // Only trigger when the entire current line starts with `/`.
  const m = value.match(/^\s*\/([A-Za-z0-9_-]*)$/);
  if (!m) {
    if (_slashState) slashClose();
    return;
  }
  const query = m[1].toLowerCase();
  // Show every match — cap at 30 so the dropdown stays reasonable on
  // small viewports but no longer hides commands at /h with no query.
  // Match either prefix on id, or substring on label / hint so users
  // typing /find can also see /find-text or /search-mem-style aliases.
  const items = SLASH_COMMANDS.filter((c) => {
    if (!query) return true;
    return c.id.startsWith(query)
      || c.label.toLowerCase().includes('/' + query)
      || (c.hint || '').toLowerCase().includes(query);
  }).slice(0, 30);
  if (!items.length) {
    if (_slashState) slashClose();
    return;
  }
  _slashState = { items, activeIdx: 0, inputEl, query };
  slashRender();
}
function slashClose() {
  _slashState = null;
  document.getElementById('slash-pop')?.classList.remove('show');
}
function slashRender() {
  let pop = document.getElementById('slash-pop');
  if (!pop) {
    pop = document.createElement('div');
    pop.id = 'slash-pop';
    pop.className = 'slash-pop';
    document.body.appendChild(pop);
  }
  const s = _slashState;
  if (!s || !s.items.length) { pop.classList.remove('show'); return; }
  pop.innerHTML = `
    <div class="slash-pop-h">SLASH${s.query ? ' · /' + esc(s.query) : ''}</div>
    <ul class="slash-pop-list">
      ${s.items.map((it, i) => `
        <li class="slash-pop-item${i === s.activeIdx ? ' on' : ''}" data-idx="${i}" onmousedown="slashApply(${i});event.preventDefault()">
          <span class="slash-pop-label">${esc(it.label)}</span>
          <span class="slash-pop-hint">${esc(it.hint)}</span>
        </li>`).join('')}
    </ul>
    <div class="slash-pop-foot"><span class="slash-pop-kbd">↵</span>/<span class="slash-pop-kbd">Tab</span> run · <span class="slash-pop-kbd">esc</span> close</div>
  `;
  // Anchor above textarea.
  const inp = s.inputEl || document.getElementById('inp');
  if (inp) {
    const r = inp.getBoundingClientRect();
    pop.style.position = 'fixed';
    pop.style.left = Math.max(8, r.left) + 'px';
    pop.style.bottom = (window.innerHeight - r.top + 6) + 'px';
    pop.style.maxWidth = Math.min(440, window.innerWidth - 16) + 'px';
  }
  pop.classList.add('show');
}
function slashKeyDown(e) {
  const s = _slashState;
  if (!s || !s.items.length) return false;
  if (e.key === 'ArrowDown') { s.activeIdx = (s.activeIdx + 1) % s.items.length; slashRender(); e.preventDefault(); return true; }
  if (e.key === 'ArrowUp')   { s.activeIdx = (s.activeIdx - 1 + s.items.length) % s.items.length; slashRender(); e.preventDefault(); return true; }
  if (e.key === 'Tab' || e.key === 'Enter') { slashApply(s.activeIdx); e.preventDefault(); return true; }
  if (e.key === 'Escape')    { slashClose(); e.preventDefault(); return true; }
  return false;
}
window.slashApply = function (idx) {
  const s = _slashState;
  if (!s || !s.items[idx]) return;
  const cmd = s.items[idx];
  const inp = s.inputEl || document.getElementById('inp');
  if (!inp) { slashClose(); return; }
  // If the user typed exactly `/foo` (no args), execute immediately.
  // Otherwise pre-fill `/foo ` so they can append an argument and hit Enter.
  if (cmd.label.includes('<') || cmd.label.includes('[')) {
    inp.value = cmd.label.split(/\s/)[0] + ' ';
    slashClose();
    inp.focus();
    inp.setSelectionRange(inp.value.length, inp.value.length);
    return;
  }
  // No-arg command — execute now.
  slashClose();
  inp.value = '';
  ar(inp);
  try { cmd.exec(); } catch (e) { if (typeof addMsg === 'function') addMsg('bot', `⚠️ /${cmd.id} failed: ${e?.message || e}`); }
};

// Called from kd() when Enter is pressed and the input starts with `/`.
// Parses `/cmd arg1 arg2 ...` and routes to the matching command.
function slashExecuteFromInput(inp) {
  const value = (inp?.value || '').trim();
  const m = value.match(/^\/([A-Za-z0-9_-]+)(?:\s+(.+))?$/);
  if (!m) return false;
  const cmdId = m[1].toLowerCase();
  const arg = (m[2] || '').trim();
  const cmd = SLASH_COMMANDS.find(c => c.id === cmdId);
  slashClose();
  if (!cmd) {
    if (typeof addMsg === 'function') addMsg('bot', `⚠️ Unknown slash command: /${cmdId}. Type /help for the list.`);
    return true;
  }
  inp.value = '';
  ar(inp);
  try { cmd.exec(arg); }
  catch (e) { if (typeof addMsg === 'function') addMsg('bot', `⚠️ /${cmd.id} failed: ${e?.message || e}`); }
  return true;
}

function slashShowHelp() {
  if (typeof addMsg !== 'function') return;
  const lines = SLASH_COMMANDS.map(c => `\`${c.label}\` — ${c.hint}`);
  addMsg('bot', '**Slash commands:**\n\n' + lines.join('\n'));
}

// ═══ PR-D2 — @-mention autocomplete (workspace symbols) ═══════════════
// Detects an `@` token at the caret position, queries the workspace
// indexer (or falls back to wsList for `@file`), shows a small popover
// anchored above the input. Tab / Enter inserts; Esc closes.
var _AT_MENTION_TYPES = ['symbol', 'file'];
var _atMentionState = null; // { kind, query, items, activeIdx } when open

function atMentionMaybeOpen(inputEl) {
  if (!inputEl) return;
  const value = inputEl.value || '';
  const caret = inputEl.selectionStart || 0;
  // Find the start of the current token by walking back from caret.
  // Token = `@` followed by 0+ non-whitespace chars.
  const before = value.slice(0, caret);
  const m = before.match(/(^|\s)@([A-Za-z0-9_./\-:]*)$/);
  if (!m) {
    if (_atMentionState) atMentionClose();
    return;
  }
  const queryRaw = m[2];
  // Determine kind: explicit prefix `file:foo` or `sym:bar`, otherwise
  // default to symbol query.
  let kind = 'symbol';
  let q = queryRaw;
  if (queryRaw.startsWith('file:')) { kind = 'file'; q = queryRaw.slice(5); }
  else if (queryRaw.startsWith('sym:'))  { kind = 'symbol'; q = queryRaw.slice(4); }
  atMentionPopulate(kind, q, inputEl);
}
function atMentionClose() {
  _atMentionState = null;
  const pop = document.getElementById('at-mention-pop');
  if (pop) pop.classList.remove('show');
}
async function atMentionPopulate(kind, query, inputEl) {
  let items = [];
  try {
    if (kind === 'symbol') {
      const r = await H.wsIndexQuery?.(query, { limit: 20 });
      if (r && r.ok) items = (r.results || []).map(s => ({
        kind: 'symbol',
        label: s.name,
        sub: `${s.kind} · ${s.file}:${s.line}`,
        insert: '@' + s.name,
      }));
      // If the index isn't built yet, kick a build (don't await — user
      // will retry). Show a helpful empty-state.
      if (r && !r.hasIndex && !r.building) {
        H.wsIndexBuild?.().catch(() => {});
        items = [{ kind: 'info', label: 'Building workspace index…', sub: 'Try again in a second.', insert: '' }];
      }
    } else if (kind === 'file') {
      const r = await H.wsList?.('');
      if (r && r.ok && Array.isArray(r.entries)) {
        const ql = query.toLowerCase();
        items = r.entries
          .filter(e => !e.isDir && e.name.toLowerCase().includes(ql))
          .slice(0, 20)
          .map(e => ({
            kind: 'file',
            label: e.name,
            sub: e.rel || '',
            insert: '@file:' + (e.rel || e.name),
          }));
      }
    }
  } catch (_) { /* dropdown stays empty */ }
  _atMentionState = { kind, query, items, activeIdx: 0, inputEl };
  atMentionRender();
}
function atMentionRender() {
  let pop = document.getElementById('at-mention-pop');
  if (!pop) {
    pop = document.createElement('div');
    pop.id = 'at-mention-pop';
    pop.className = 'at-mention-pop';
    document.body.appendChild(pop);
  }
  const s = _atMentionState;
  if (!s || !s.items?.length) {
    pop.classList.remove('show');
    return;
  }
  pop.innerHTML = `
    <div class="at-mention-head">${esc(s.kind.toUpperCase())} · ${esc(s.query || '(empty)')}</div>
    <ul class="at-mention-list">
      ${s.items.map((it, i) => `
        <li class="at-mention-item${i === s.activeIdx ? ' on' : ''} kind-${esc(it.kind)}" data-idx="${i}" onmousedown="atMentionInsert(${i});event.preventDefault()">
          <span class="at-mention-name">${esc(it.label)}</span>
          <span class="at-mention-sub">${esc(it.sub || '')}</span>
        </li>`).join('')}
    </ul>
    <div class="at-mention-foot"><span class="at-mention-kbd">Tab</span>/<span class="at-mention-kbd">↵</span> insert · <span class="at-mention-kbd">↑↓</span> nav · <span class="at-mention-kbd">esc</span> close</div>
  `;
  // Anchor above the textarea.
  const inp = s.inputEl || document.getElementById('inp');
  if (inp) {
    const r = inp.getBoundingClientRect();
    pop.style.position = 'fixed';
    pop.style.left = Math.max(8, r.left) + 'px';
    pop.style.bottom = (window.innerHeight - r.top + 6) + 'px';
    pop.style.maxWidth = Math.min(420, window.innerWidth - 16) + 'px';
  }
  pop.classList.add('show');
}
function atMentionKeyDown(e) {
  const s = _atMentionState;
  if (!s || !s.items?.length) return false;
  const len = s.items.length;
  if (e.key === 'ArrowDown') {
    s.activeIdx = (s.activeIdx + 1) % len;
    atMentionRender();
    e.preventDefault(); return true;
  }
  if (e.key === 'ArrowUp') {
    s.activeIdx = (s.activeIdx - 1 + len) % len;
    atMentionRender();
    e.preventDefault(); return true;
  }
  if (e.key === 'Tab' || e.key === 'Enter') {
    atMentionInsert(s.activeIdx);
    e.preventDefault(); return true;
  }
  if (e.key === 'Escape') {
    atMentionClose();
    e.preventDefault(); return true;
  }
  return false;
}
window.atMentionInsert = function (idx) {
  const s = _atMentionState;
  if (!s || !s.items?.[idx]) return;
  const item = s.items[idx];
  if (!item.insert) { atMentionClose(); return; }
  const inp = s.inputEl || document.getElementById('inp');
  if (!inp) { atMentionClose(); return; }
  const value = inp.value || '';
  const caret = inp.selectionStart || 0;
  // Replace the partial @-token before the caret.
  const before = value.slice(0, caret);
  const after = value.slice(caret);
  const m = before.match(/(^|\s)@[A-Za-z0-9_./\-:]*$/);
  if (!m) { atMentionClose(); return; }
  const tokenStart = m.index + m[1].length;
  const newValue = value.slice(0, tokenStart) + item.insert + ' ' + after;
  inp.value = newValue;
  const newCaret = tokenStart + item.insert.length + 1;
  inp.setSelectionRange(newCaret, newCaret);
  ar(inp);
  atMentionClose();
  inp.focus();
};


