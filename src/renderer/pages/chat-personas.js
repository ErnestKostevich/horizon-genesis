// PR-V Phase 3.2 — Personas Editor module.
// Extracted from chat.html inline <script> (was lines 3955-4270).
// Behaviour identical; loaded as external script AFTER main inline
// so window.* globals it reads (H, customConfirm, customPrompt,
// setPersona, currentPersona, etc.) are defined.
//
// All top-level var/function declarations bind to window (cross-script
// visible) thanks to Phase 2 let/const → var conversion. Functions
// called from HTML onclick handlers (peSelect, peCreateCustom,
// peSavePrompt, peDelete, etc.) all stay on window.

// personas (built-ins + custom). Right: detail with system prompt
// (Russian + English), allowed-tools toggles, and long-term memories.
// Edits persist via H.personaUpsert; deleting a built-in resets it to
// default. Refreshes on tab open + after save / delete.
var _peActiveId = null;
var _peCache = { list: [], full: {} };

var PE_TOOLS = [
  { name: 'fs.read',  label: 'Read files',  write: false },
  { name: 'fs.write', label: 'Write files', write: true  },
  { name: 'shell',    label: 'Shell',       write: true  },
  { name: 'web.fetch', label: 'Web fetch',  write: false },
  { name: 'web.search', label: 'Web search', write: false },
  { name: 'screenshot', label: 'Screenshot', write: false },
  { name: 'computer.click', label: 'Computer click', write: true },
  { name: 'computer.type',  label: 'Computer type',  write: true }
];

async function loadPersonaSelect() {
  const sel = document.getElementById('persona-select');
  if (!sel) return;
  let list = [];
  try { list = await H.getPersonas(); } catch (_) { list = []; }
  if (!Array.isArray(list) || !list.length) return;
  const saved = await H.get('persona').catch(() => currentPersona);
  sel.innerHTML = list.map(p => {
    const label = `${p.icon || ''} ${p.name || p.id}`.trim();
    return `<option value="${escHtml(p.id)}">${escHtml(label)}</option>`;
  }).join('');
  if (saved && list.some(p => p.id === saved)) {
    currentPersona = saved;
    sel.value = saved;
  } else if (list.some(p => p.id === currentPersona)) {
    sel.value = currentPersona;
  } else {
    currentPersona = list[0].id;
    sel.value = currentPersona;
  }
  try { updateInspector(); } catch(_){}
}

async function renderPersonasEditor() {
  const mount = document.getElementById('pe-mount');
  if (!mount) return;
  let list = [];
  try { list = await H.getPersonas(); } catch (_) { list = []; }
  _peCache.list = Array.isArray(list) ? list : [];
  if (!_peCache.list.length) {
    mount.innerHTML = '<div class="info-box">Personas module unavailable. Reload the app and try again.</div>';
    return;
  }
  if (!_peActiveId || !_peCache.list.find(p => p.id === _peActiveId)) {
    _peActiveId = _peCache.list[0].id;
  }
  // Skeleton — body filled in by _renderPeBody after fetching the full
  // shape (prompt + tools + memories) for the active persona.
  mount.innerHTML = `
    <div class="pe-shell">
      <aside class="pe-list">
        <div class="pe-list-h">
          <span class="pe-list-h-t">Personas · ${_peCache.list.length}</span>
          <button class="pe-list-add" onclick="peCreateCustom()">+ New</button>
        </div>
        <div class="pe-list-body" id="pe-list-body"></div>
      </aside>
      <main class="pe-detail" id="pe-detail">
        <div class="pe-detail-empty">
          <div class="pe-detail-empty-icon">⏳</div>
          <div class="pe-detail-empty-text">Loading…</div>
        </div>
      </main>
    </div>
  `;
  _renderPeList();
  await _renderPeBody();
}

function _renderPeList() {
  const body = document.getElementById('pe-list-body');
  if (!body) return;
  body.innerHTML = _peCache.list.map(p => {
    const id = String(p.id || '');
    const jsId = id.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const active = id && id === currentPersona;
    return `
    <div class="pe-item ${id === _peActiveId ? 'on' : ''} ${active ? 'active' : ''}" onclick="peSelect('${jsId}')">
      <div class="pe-item-icon">${p.icon || 'P'}</div>
      <div class="pe-item-name">${(p.name || id || 'Untitled').replace(/[<>]/g, '')}</div>
      <span class="pe-item-tag">${active ? 'ACTIVE' : (p.builtin ? 'BUILTIN' : 'CUSTOM')}</span>
    </div>
  `}).join('');
}

async function _renderPeBody() {
  const detail = document.getElementById('pe-detail');
  if (!detail) return;
  if (!_peActiveId) {
    detail.innerHTML = '<div class="pe-detail-empty"><div class="pe-detail-empty-icon">🎭</div><div class="pe-detail-empty-text">Pick a persona on the left.</div></div>';
    return;
  }
  let full = _peCache.full[_peActiveId];
  if (!full) {
    try { full = await H.getPersonaFull(_peActiveId); } catch (_) { full = null; }
    if (full) _peCache.full[_peActiveId] = full;
  }
  if (!full) {
    detail.innerHTML = '<div class="pe-detail-empty"><div class="pe-detail-empty-icon">⚠️</div><div class="pe-detail-empty-text">Failed to load this persona.</div></div>';
    return;
  }
  const allowed = Array.isArray(full.allowedTools) ? full.allowedTools : null; // null = all allowed
  const memories = Array.isArray(full.memories) ? full.memories : [];
  const ru = (full.prompt && full.prompt.ru) || '';
  const en = (full.prompt && full.prompt.en) || '';
  const isCustom = full.builtin === false;

  detail.innerHTML = `
    <div class="pe-detail-h">
      <div class="pe-detail-h-t">
        <span style="font-size:22px">${full.icon || '🪪'}</span>
        <span>${(full.name || _peActiveId).replace(/[<>]/g,'')}</span>
        <span class="pe-item-tag" style="margin-left:8px">${full.builtin ? 'BUILT-IN' : 'CUSTOM'}</span>
      </div>
      <div class="pe-detail-h-actions">
        ${full.builtin
          ? '<button class="wfp-btn" onclick="peReset()" title="Discard your overlay and restore the default">Reset</button>'
          : '<button class="wfp-btn del" onclick="peDelete()" title="Delete this persona">Delete</button>'
        }
        <button class="wfp-btn" onclick="peActivate()" title="Use this persona in chat">Activate</button>
        <button class="wfp-btn run" onclick="peSave()">Save</button>
      </div>
    </div>

    <div class="pe-section-h">SYSTEM PROMPT — RU</div>
    <textarea class="pe-prompt" id="pe-prompt-ru" placeholder="System prompt (Russian)…">${(ru || '').replace(/[<>]/g,'')}</textarea>

    <div class="pe-section-h">SYSTEM PROMPT — EN</div>
    <textarea class="pe-prompt" id="pe-prompt-en" placeholder="System prompt (English)…">${(en || '').replace(/[<>]/g,'')}</textarea>

    <div class="pe-section-h">ALLOWED TOOLS</div>
    <div class="pe-tools" id="pe-tools">
      ${PE_TOOLS.map(t => {
        const on = allowed === null ? true : allowed.includes(t.name);
        return `<button class="pe-tool ${on ? 'on' : ''} ${on && t.write ? 'write' : ''}"
                        data-tool="${t.name}" data-write="${t.write ? '1' : ''}"
                        onclick="peToggleTool(this)">
                  ${t.label}${t.write ? ' ⚠' : ''}
                </button>`;
      }).join('')}
      <button class="pe-tool" onclick="peAllowAll()" style="margin-left:auto;border-style:dashed">All</button>
    </div>
    <div style="font-size:11px;color:var(--t3);margin-top:6px">⚠ = write/destructive tool. The Permission Gate still asks before each call.</div>

    <div class="pe-section-h">LONG-TERM MEMORIES — ${memories.length}</div>
    <div class="pe-mems" id="pe-mems">
      ${memories.length === 0
        ? '<div style="color:var(--t3);font-size:12px;padding:6px 0">No memories yet. Add facts the persona should always remember.</div>'
        : memories.map(m => `
          <div class="pe-mem" data-mid="${m.id || ''}">
            <div class="pe-mem-icon">📌</div>
            <div class="pe-mem-text">${(m.text || '').replace(/[<>]/g,'')}</div>
            <button class="pe-mem-x" onclick="peRemoveMem('${(m.id || '').replace(/'/g,"\\'")}')">×</button>
          </div>
        `).join('')
      }
    </div>
    <div class="pe-mem-add">
      <input class="pe-mem-input" id="pe-mem-input" placeholder="Add a new memory… (Enter to save)" onkeydown="if(event.key==='Enter')peAddMem()"/>
      <button class="wfp-btn run" onclick="peAddMem()">Add</button>
    </div>
  `;
}

window.peSelect = async function (id) {
  _peActiveId = id;
  try { await setPersona(id, { announce: false }); } catch (_) {}
  _renderPeList();
  await _renderPeBody();
};

window.peActivate = async function () {
  if (!_peActiveId) return;
  try {
    await setPersona(_peActiveId, { announce: false });
    _renderPeList();
    H.notify('Personas', 'Activated');
  } catch (e) {
    H.notify('Personas', 'Activate failed: ' + (e.message || e));
  }
};

window.peToggleTool = function (btn) {
  const isOn = btn.classList.contains('on');
  btn.classList.toggle('on', !isOn);
  if (btn.dataset.write === '1') {
    btn.classList.toggle('write', !isOn);
  }
};

window.peAllowAll = function () {
  document.querySelectorAll('#pe-tools .pe-tool[data-tool]').forEach(b => {
    b.classList.add('on');
    if (b.dataset.write === '1') b.classList.add('write');
  });
};

function _peCollectAllowedTools() {
  const onBtns = [...document.querySelectorAll('#pe-tools .pe-tool.on[data-tool]')];
  const onNames = onBtns.map(b => b.dataset.tool);
  // If the user has all tools enabled, persist null (= "no restriction")
  // — keeps behaviour symmetric with un-edited built-ins.
  if (onNames.length === PE_TOOLS.length) return null;
  return onNames;
}

window.peAddMem = function () {
  const input = document.getElementById('pe-mem-input');
  if (!input) return;
  const text = (input.value || '').trim();
  if (!text) return;
  const full = _peCache.full[_peActiveId] || (_peCache.full[_peActiveId] = {});
  full.memories = Array.isArray(full.memories) ? full.memories : [];
  full.memories.push({ id: 'm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), text, ts: Date.now() });
  input.value = '';
  _renderPeBody();
};

window.peRemoveMem = function (mid) {
  const full = _peCache.full[_peActiveId];
  if (!full || !Array.isArray(full.memories)) return;
  full.memories = full.memories.filter(m => (m.id || '') !== mid);
  _renderPeBody();
};

window.peSave = async function () {
  const ru = document.getElementById('pe-prompt-ru')?.value ?? '';
  const en = document.getElementById('pe-prompt-en')?.value ?? '';
  const allowedTools = _peCollectAllowedTools();
  const full = _peCache.full[_peActiveId] || {};
  const memories = Array.isArray(full.memories) ? full.memories : [];
  const patch = {
    prompt: { ru, en },
    allowedTools,
    memories
  };
  try {
    const res = await H.personaUpsert(_peActiveId, patch);
    if (res && res.ok === false) {
      H.notify('Personas', 'Save failed: ' + (res.error || 'unknown'));
      return;
    }
    // Refresh cache for this persona from canonical store.
    delete _peCache.full[_peActiveId];
    H.notify('Personas', 'Saved');
    await renderPersonasEditor();
    await loadPersonaSelect();
  } catch (e) {
    H.notify('Personas', 'Save failed: ' + (e.message || e));
  }
};

window.peReset = async function () {
  const ok = await customConfirm('Discard your overlay and restore default for this built-in persona?');
  if (!ok) return;
  try {
    await H.personaDelete(_peActiveId);
    delete _peCache.full[_peActiveId];
    H.notify('Personas', 'Reset to default');
    await renderPersonasEditor();
    await loadPersonaSelect();
  } catch (e) {
    H.notify('Personas', 'Reset failed: ' + (e.message || e));
  }
};

window.peDelete = async function () {
  const ok = await customConfirm('Delete this custom persona? This cannot be undone.');
  if (!ok) return;
  try {
    await H.personaDelete(_peActiveId);
    delete _peCache.full[_peActiveId];
    _peActiveId = null;
    H.notify('Personas', 'Deleted');
    await renderPersonasEditor();
    await loadPersonaSelect();
  } catch (e) {
    H.notify('Personas', 'Delete failed: ' + (e.message || e));
  }
};

window.peCreateCustom = async function () {
  const entered = await customPrompt('Name for the new persona', '');
  const name = String(entered || '').trim();
  if (!name) return;
  const slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'persona';
  const id = 'custom_' + slug + '_' + Date.now().toString(36);
  try {
    await H.personaUpsert(id, {
      name,
      icon: '🪪',
      color: '#56d2ff',
      prompt: {
        ru: 'Ты — ' + name + '. Опиши тут стиль и тон.',
        en: 'You are ' + name + '. Describe the style and tone here.'
      },
      allowedTools: null,
      memories: []
    });
    _peActiveId = id;
    delete _peCache.full[id];
    H.notify('Personas', 'Created: ' + name);
    await renderPersonasEditor();
    await loadPersonaSelect();
  } catch (e) {
    H.notify('Personas', 'Create failed: ' + (e.message || e));
  }
};

