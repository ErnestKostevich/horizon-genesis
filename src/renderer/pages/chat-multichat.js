// PR-V Phase 3.18 — Multi-chat persistence + chat-delete permission +
// auto-naming. Extracted from chat.html inline <script> (was lines
// 1762-2160).
//
// The multi-chat layer: list, create, switch, rename, delete chats;
// sidebar render with search filter; permission gate for delete
// (with optional always-allow); per-message persistence to
// electron-store via H.chatStore; auto-name the chat after first
// reply.
//
// Functions:
//   renderChatSidebar — main sidebar list render
//   filterChats — sidebar search filter
//   loadChatList — pull list from main process, render
//   _replayMessages — restore message DOM when switching chats
//   switchChat — switch active chat, replay messages
//   createNewChat — create + switch to a new empty chat
//   getSavedPermissionAllowlist — read allowlist from store
//   hasAlwaysAllowChatDelete — has user pre-approved chat-delete
//   rememberAlwaysAllowChatDelete — persist always-allow
//   confirmChatDeletePermission — show permission card if not allowed
//   renameChatPrompt — prompt for new title, save
//   deleteChatConfirm — gated delete with optional always-allow
//   bootCurrentChat — restore active chat from store on boot
//   _chatListRefreshTimer + _scheduleChatListRefresh — debounce
//     sidebar refreshes during burst writes
//   _persistChatMessage — save a message to the chat store
//   _autoNameChat — ask LLM for a chat title after first reply
//
// Loaded as external script AFTER main inline so window.* globals it
// reads (H IPC, lang, currentChatId, addMsg, requestPermission, etc.)
// are defined.

function renderChatSidebar(){
  const list = document.getElementById('chatlist');
  if (!list) return;
  list.innerHTML = '';
  // Filter by search
  let filtered = chatsCache || [];
  if (chatSearchQuery) {
    const q = chatSearchQuery.toLowerCase();
    filtered = filtered.filter(c => (c.title||'').toLowerCase().includes(q) || (c.preview||'').toLowerCase().includes(q));
  }
  if (!filtered.length) {
    const empty = document.createElement('div');
    empty.className = 'cs-empty';
    empty.textContent = chatSearchQuery ? (lang==='ru'?'Ничего не найдено':'No matches') : t('noChatsYet');
    list.appendChild(empty);
    return;
  }
  const groups = { today: [], yesterday: [], thisWeek: [], thisMonth: [], older: [] };
  for (const c of filtered) groups[_chatGroupKey(c.updated_at)].push(c);
  const order = ['today','yesterday','thisWeek','thisMonth','older'];
  for (const key of order) {
    const arr = groups[key];
    if (!arr.length) continue;
    const h = document.createElement('div');
    h.className = 'cs-group-heading';
    h.textContent = t(key);
    list.appendChild(h);
    for (const c of arr) {
      const item = document.createElement('div');
      item.className = 'cs-item' + (c.id === currentChatId ? ' active' : '');
      item.dataset.chatId = c.id;
      const titleText = (c.title && c.title.trim()) ? c.title : t('untitledChat');
      const preview = c.preview || '';
      // Build DOM properly instead of innerHTML with escaped quotes
      const titleDiv = document.createElement('div');
      titleDiv.className = 'cs-title';
      titleDiv.title = titleText;
      titleDiv.textContent = titleText;
      item.appendChild(titleDiv);
      if (preview) {
        const prevDiv = document.createElement('div');
        prevDiv.className = 'cs-preview';
        prevDiv.textContent = preview;
        item.appendChild(prevDiv);
      }
      const metaDiv = document.createElement('div');
      metaDiv.className = 'cs-meta';
      metaDiv.textContent = _shortTs(c.updated_at) + ' · ' + (c.message_count||0) + ' msgs';
      item.appendChild(metaDiv);
      // Action buttons — built via DOM, not innerHTML
      const actions = document.createElement('div');
      actions.className = 'cs-actions';
      const renBtn = document.createElement('button');
      renBtn.className = 'cs-act-btn';
      renBtn.title = t('renameChat');
      renBtn.setAttribute('aria-label', t('renameChat'));
      // Sprint-2 fix — was textContent '✎', now lucide SVG.
      renBtn.innerHTML = '<svg class="licon"><use href="#i-edit"/></svg>';
      renBtn.addEventListener('click', (e) => { e.stopPropagation(); renameChatPrompt(c.id); });
      actions.appendChild(renBtn);
      const delBtn = document.createElement('button');
      delBtn.className = 'cs-act-btn danger';
      delBtn.title = t('deleteChat');
      delBtn.textContent = '×';
      delBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteChatConfirm(c.id); });
      actions.appendChild(delBtn);
      item.appendChild(actions);
      item.addEventListener('click', () => switchChat(c.id));
      list.appendChild(item);
    }
  }
}
function filterChats(query) {
  chatSearchQuery = (query || '').trim();
  renderChatSidebar();
}
async function loadChatList(){
  try {
    const list = await H.chatList();
    chatsCache = Array.isArray(list) ? list : [];
    renderChatSidebar();
  } catch (e) { console.warn('chatList failed:', e?.message); }
}
function _replayMessages(messages, chatId){
  const w = document.getElementById('msgs');
  if (!w) return;
  w.innerHTML = '';
  chatHistory = [];
  // Reset per-chat counters; they'll be re-accumulated as we replay.
  sessionTokens = 0;
  sessionMsgs = 0;
  sessionUsageKnown = false;
  sessionHasEstimatedUsage = false;
  sessionUsageUnavailable = false;
  try {
    const p = loadOperatorLogForCurrentChat?.(chatId || currentChatId);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (_) {}
  if (!messages || messages.length === 0) {
    // Empty chat → restore the welcome greeting so the canvas isn't blank.
    if (typeof showGreeting === 'function') {
      try { showGreeting(); } catch(_){}
    }
    updateTokenDisplay();
    return;
  }
  for (const m of messages) {
    const role = m.role === 'assistant' ? 'bot' : 'user';
    const meta = m.meta || {};
    addMsg(role, m.content || '', { model: meta.model });
    chatHistory.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content || '' });
    // Re-account tokens for this chat. If meta.usage is present (provider
    // returned real token counts at send time and we persisted them), use
    // it — the running session totals then survive chat-switch / reload
    // instead of degrading to "usage unavailable" the moment you click
    // away from a chat. Falls back to the heuristic when meta.usage is
    // absent (e.g. messages persisted before this fix landed).
    try {
      trackTokens(
        m.content || '',
        m.role === 'assistant' ? 'assistant' : 'user',
        meta.provider || prov,
        meta.usage,
        meta.estimatedTokens
      );
    } catch(_){}
  }
}
async function switchChat(id){
  if (!id || id === currentChatId) return;
  try {
    const chat = await H.chatSwitch(id);
    if (!chat || !chat.id) return;
    currentChatId = chat.id;
    _replayMessages(chat.messages, chat.id);
    renderChatSidebar();
    updateStatusBar(chat.title);
  } catch (e) { console.warn('switchChat failed:', e?.message); }
}
async function createNewChat(){
  try {
    const chat = await H.chatCreate({});
    if (!chat || !chat.id) return;
    currentChatId = chat.id;
    _replayMessages([], chat.id);
    await loadChatList();
    updateStatusBar(lang==='ru'?'Новый чат':'New chat');
    setTimeout(()=>{ try { document.getElementById('inp')?.focus(); } catch(_){} }, 30);
  } catch (e) { console.warn('createNewChat failed:', e?.message); }
}
// ═══ Custom prompt / confirm — window.prompt is disabled in Electron renderer
// (returns immediately without showing UI), so we ship our own modals.
function customPrompt(title, defaultValue) {
  return new Promise(resolve => {
    try {
      const overlay = document.createElement('div');
      overlay.className = 'perm-overlay';
      const card = document.createElement('div');
      card.className = 'perm-card';
      card.style.maxWidth = '420px';
      card.innerHTML =
        '<div class="perm-eyebrow">'+_escHtml(lang==='ru'?'Ввод':'Input')+'</div>'+
        '<div class="perm-title">'+_escHtml(title || '')+'</div>'+
        '<input type="text" class="cprompt-input" style="width:100%;background:rgba(0,0,0,.4);border:1px solid var(--b1);border-radius:7px;padding:10px 12px;color:var(--tx);font:13px var(--font);margin-bottom:18px;outline:none;box-sizing:border-box" />'+
        '<div class="perm-actions">'+
          '<button class="perm-btn deny" data-act="cancel">'+_escHtml(lang==='ru'?'Отмена':'Cancel')+'</button>'+
          '<button class="perm-btn allow" data-act="ok">'+_escHtml(lang==='ru'?'Сохранить':'Save')+' ⏎</button>'+
        '</div>';
      overlay.appendChild(card);
      document.body.appendChild(overlay);
      const input = card.querySelector('.cprompt-input');
      input.value = defaultValue || '';
      input.focus();
      input.select();
      const cleanup = (val) => {
        try { document.removeEventListener('keydown', onKey); } catch(_){}
        try { overlay.remove(); } catch(_){}
        resolve(val);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); cleanup(null); }
        else if (e.key === 'Enter') { e.preventDefault(); cleanup(input.value); }
      };
      document.addEventListener('keydown', onKey);
      card.querySelector('[data-act="cancel"]').onclick = () => cleanup(null);
      card.querySelector('[data-act="ok"]').onclick = () => cleanup(input.value);
    } catch(_) { resolve(null); }
  });
}
function customConfirm(message) {
  return requestPermission({
    eyebrow: lang==='ru'?'Подтверждение':'Confirm',
    title: lang==='ru'?'Уверены?':'Are you sure?',
    description: message || ''
  });
}

var CHAT_DELETE_ALLOW_ID = 'ui.chat.delete.global';
async function getSavedPermissionAllowlist(){
  try {
    const r = await H.permissionAllowlistList?.();
    if (Array.isArray(r?.entries)) return r.entries;
  } catch(_) {}
  try {
    const raw = await H.get?.('permissionAllowlist');
    if (Array.isArray(raw)) return raw.filter(Boolean);
    if (raw && typeof raw === 'object') return Object.values(raw).filter(Boolean);
  } catch(_) {}
  return [];
}
async function hasAlwaysAllowChatDelete(){
  const entries = await getSavedPermissionAllowlist();
  return entries.some(e => e && (e.id === CHAT_DELETE_ALLOW_ID || (e.tool === 'ui.chat.delete' && e.operation === 'delete_chat')));
}
async function rememberAlwaysAllowChatDelete(){
  const entries = await getSavedPermissionAllowlist();
  if (entries.some(e => e && e.id === CHAT_DELETE_ALLOW_ID)) return;
  entries.push({
    id: CHAT_DELETE_ALLOW_ID,
    workspace: '*',
    persona: '*',
    tool: 'ui.chat.delete',
    operation: 'delete_chat',
    scope: '*',
    title: 'Delete chats',
    createdAt: new Date().toISOString()
  });
  await H.set?.('permissionAllowlist', entries);
}
async function confirmChatDeletePermission(){
  if (await hasAlwaysAllowChatDelete()) return true;
  const decision = await requestPermission({
    returnDecision: true,
    eyebrow: 'Human-in-the-loop approval',
    title: 'Delete chat',
    description: t('confirmDeleteChat'),
    detail: 'This removes one local chat from Horizon history.'
  });
  if (decision === 'always_allow') {
    await rememberAlwaysAllowChatDelete();
    return true;
  }
  return decision === 'allow_once';
}

async function renameChatPrompt(id){
  try {
    const cur = chatsCache.find(c => c.id === id);
    const old = cur && cur.title ? cur.title : '';
    const next = await customPrompt(t('chatRenamePrompt'), old);
    if (next === null) return;
    const trimmed = String(next).trim();
    if (!trimmed) return;
    await H.chatRename(id, trimmed);
    await loadChatList();
    if (id === currentChatId) updateStatusBar(trimmed);
  } catch (e) { console.warn('renameChat failed:', e?.message); }
}
async function deleteChatConfirm(id){
  try {
    const ok = await confirmChatDeletePermission();
    if (!ok) return;
    const res = await H.chatDelete(id);
    if (id === currentChatId) {
      if (res && res.next_current_id) {
        await switchChat(res.next_current_id);
      } else {
        await createNewChat();
      }
    } else {
      await loadChatList();
    }
  } catch (e) { console.warn('deleteChat failed:', e?.message); }
}
async function bootCurrentChat(){
  try {
    const cur = await H.chatGetCurrent();
    if (cur && cur.id) {
      currentChatId = cur.id;
      if (Array.isArray(cur.messages) && cur.messages.length) {
        _replayMessages(cur.messages, cur.id);
      } else {
        try { showGreeting?.(); } catch(_){}
        try {
          const p = loadOperatorLogForCurrentChat?.(cur.id);
          if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch(_){}
      }
      updateStatusBar(cur.title);
    }
    document.body.classList.add('with-sidebar');
    document.getElementById('chatside')?.removeAttribute('hidden');
    try { document.getElementById('cs-new-btn').textContent = t('newChat'); } catch(_){}
    try { document.getElementById('cs-search').placeholder = lang==='ru'?'Поиск чатов…':'Search chats…'; } catch(_){}
    await loadChatList();
    refreshLicensePill();
  } catch (e) { console.warn('bootCurrentChat failed:', e?.message); }
}
// Debounced sidebar refresh — persistChatMessage fires 2-4 times per turn
// (user msg + assistant msg + tool / agent step messages). Coalesce them
// into a single loadChatList() call after the burst settles, otherwise the
// sidebar wastes IPC and re-renders mid-stream.
var _chatListRefreshTimer = null;
function _scheduleChatListRefresh(){
  if (_chatListRefreshTimer) clearTimeout(_chatListRefreshTimer);
  _chatListRefreshTimer = setTimeout(() => {
    _chatListRefreshTimer = null;
    try { loadChatList?.(); } catch(_){}
  }, 350);
}

async function _ensureCurrentChatIdForPersist(){
  if (currentChatId) return currentChatId;
  try {
    const cur = await H.chatGetCurrent?.();
    if (cur && cur.id) {
      currentChatId = cur.id;
      return currentChatId;
    }
  } catch (e) {
    console.warn('[chat] chatGetCurrent failed before persist:', e?.message || e);
  }
  try {
    const chat = await H.chatCreate?.({});
    if (chat && chat.id) {
      currentChatId = chat.id;
      _scheduleChatListRefresh();
      return currentChatId;
    }
  } catch (e) {
    console.warn('[chat] chatCreate failed before persist:', e?.message || e);
  }
  return null;
}

function _persistChatMessage(role, content, meta){
  currentChatId = currentChatId || null;
  if (false && !currentChatId) {
    console.warn('[chat] _persistChatMessage skipped — no currentChatId');
    return;
  }
  // chatAddMessage is an IPC invoke — it returns a Promise. The previous
  // try/catch only caught synchronous errors and silently dropped any IPC
  // rejection. Log the rejection so persistence failures show up in
  // DevTools instead of looking like a phantom "messages don't save" bug.
  Promise.resolve()
    .then(async () => {
      const chatId = await _ensureCurrentChatIdForPersist();
      if (!chatId) {
        console.warn('[chat] _persistChatMessage skipped - no currentChatId');
        return { ok: false, error: 'no current chat' };
      }
      return H.chatAddMessage(chatId, role, content, meta || {});
    })
    .then(r => {
      if (r && r.ok === false) console.warn('[chat] chatAddMessage rejected:', r.error || r);
      // Refresh the sidebar so msg count + last-modified timestamp + the
      // backend's stripPreview title (used as a fallback when AI auto-name
      // hasn't fired yet) reflect on screen.
      _scheduleChatListRefresh();
    })
    .catch(e => console.warn('[chat] chatAddMessage threw:', e?.message || e));
  // After the first user message, trigger AI auto-naming. Use === 0
  // (not <= 1): the previous gate fired on the first AND second message
  // because trackTokens increments sessionMsgs AFTER this call. Firing
  // twice meant a second model round-trip overwrote a perfectly good
  // first title. Stick to once per chat.
  if (role === 'user' && sessionMsgs === 0) {
    _autoNameChat(content);
  }
}
// AI auto-name: replace whatever placeholder/stripPreview title the backend
// stuck on the chat with a 3–6 word AI-generated label. Mirrors how ChatGPT
// and Cursor name new threads.
//
// Earlier code returned early if the chat had ANY non-empty title — but
// agent.js:748 (chatStore.addMessage) auto-stamps the first 50 chars of the
// user's message AS the title before this function ever gets called. That
// made the early-return ALWAYS fire after the first message and AI naming
// never ran. We trust the call-site gate (sessionMsgs <= 1) instead and
// always overwrite when we have a real candidate title from the model.
async function _autoNameChat(userMsg) {
  if (!currentChatId) {
    console.warn('[autoname] skipped — no currentChatId');
    return;
  }
  try {
    const sys = 'Generate a very short chat title (3-6 words max) for a conversation starting with the following message. Return ONLY the title, no quotes, no explanation.';
    const opts = aiOptsForProvider(prov);
    console.log('[autoname] requesting title via', prov, opts);
    const res = await H.ai([{role:'user', content: userMsg}], prov, sys, opts);
    if (res?.error) {
      console.warn('[autoname] provider error:', res.error);
      return;
    }
    if (res && res.reply) {
      const title = res.reply.trim().replace(/^["']|["']$/g,'').slice(0,50);
      if (title) {
        const rr = await H.chatRename(currentChatId, title);
        if (rr && rr.ok === false) console.warn('[autoname] chatRename rejected:', rr.error || rr);
        updateStatusBar(title);
        await loadChatList();
        console.log('[autoname] renamed →', title);
      } else {
        console.warn('[autoname] empty title from model:', res.reply);
      }
    } else {
      console.warn('[autoname] no reply field on response:', res);
    }
  } catch(e) {
    console.warn('[autoname] threw:', e?.message || e);
  }
}

