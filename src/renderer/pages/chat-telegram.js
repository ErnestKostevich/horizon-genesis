// Telegram chat viewer — shows the conversations the Horizon Telegram bot
// is having on the user's behalf. History lives in settingsStore on the
// local machine (connection.telegram_bot.history.<chatId>); this panel
// reads + live-updates via H.onTelegramMessage and lets the user reply
// from the desktop UI.
//
// State: tgCurrentChatId, tgChatsCache, tgHistoryCache, tgUnsubHandlers
// Fns:
//   openTelegramHub, closeTelegramHub, tgSelectChat, tgRenderList,
//   tgRenderThread, tgSendDraft, tgClearCurrent

var tgCurrentChatId = null;
var tgChatsCache = [];
var tgHistoryCache = [];
var tgUnsubHandlers = [];
var tgListSubscribed = false;

function _tgFmtTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    return sameDay
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}

function _tgAvatar(chat) {
  const seed = String(chat?.title || chat?.user || chat?.chatId || '?').trim().charAt(0).toUpperCase() || '?';
  return `<div class="tg-avatar">${esc(seed)}</div>`;
}

function openTelegramHub() {
  setActiveSurface('telegram', { keepPanels: ['telegram-panel'] });
  document.getElementById('telegram-panel').classList.add('show');
  _tgSubscribeListLive();
  tgRefreshChats();
}

function closeTelegramHub() {
  document.getElementById('telegram-panel').classList.remove('show');
  if (isSurfaceActive('telegram')) closeActiveSurface();
}

function _tgSubscribeListLive() {
  if (tgListSubscribed) return;
  tgListSubscribed = true;
  // Live tap: on every new message, refresh the chat-list metadata and (if
  // viewing this chat) append the new entry to the thread. We don't reload
  // the whole history — just push the new entry on top of the cache.
  try {
    const offMsg = H.onTelegramMessage?.(({ chatId, entry }) => {
      tgRefreshChats(); // metadata changed
      if (tgCurrentChatId && String(tgCurrentChatId) === String(chatId)) {
        tgHistoryCache.push(entry);
        _tgAppendMessage(entry);
      }
    });
    const offChats = H.onTelegramChats?.(() => { tgRefreshChats(); });
    if (offMsg) tgUnsubHandlers.push(offMsg);
    if (offChats) tgUnsubHandlers.push(offChats);
  } catch (_) {}
}

async function tgRefreshChats() {
  try {
    const r = await H.tgListChats();
    tgChatsCache = (r && r.ok && Array.isArray(r.chats)) ? r.chats : [];
    tgRenderList();
  } catch (e) {
    const list = document.getElementById('tg-chat-list');
    if (list) list.innerHTML = `<div class="tg-empty">Error: ${esc(e.message)}</div>`;
  }
}

function tgRenderList() {
  const list = document.getElementById('tg-chat-list');
  if (!list) return;
  if (!tgChatsCache.length) {
    list.innerHTML = `
      <div class="tg-empty">
        <div style="opacity:.5;margin-bottom:8px"><svg class="licon lg"><use href="#i-message"/></svg></div>
        <strong>No Telegram chats yet</strong>
        <p>Enable the Telegram bot runtime in Settings → Connections, then send your bot a message. Conversations appear here.</p>
      </div>`;
    return;
  }
  list.innerHTML = tgChatsCache.map(c => {
    const active = String(tgCurrentChatId) === String(c.chatId) ? ' on' : '';
    const title = esc(c.title || c.user || `Chat ${c.chatId}`);
    const preview = esc((c.lastMsg || '').slice(0, 80));
    const when = _tgFmtTime(c.lastMsgAt);
    const count = c.count ? `<span class="tg-row-count">${c.count}</span>` : '';
    return `
      <button class="tg-row${active}" onclick="tgSelectChat('${esc(String(c.chatId))}')">
        ${_tgAvatar(c)}
        <div class="tg-row-body">
          <div class="tg-row-head">
            <span class="tg-row-title">${title}</span>
            <span class="tg-row-when">${when}</span>
          </div>
          <div class="tg-row-preview">${preview}</div>
        </div>
        ${count}
      </button>
    `;
  }).join('');
}

async function tgSelectChat(chatId) {
  tgCurrentChatId = chatId;
  tgRenderList();
  const thread = document.getElementById('tg-thread');
  if (thread) thread.innerHTML = '<div class="tg-empty" style="padding:20px">Loading history...</div>';
  try {
    const r = await H.tgGetHistory(chatId, 400);
    if (!r?.ok) {
      if (thread) thread.innerHTML = `<div class="tg-empty">${esc(r?.error || 'Failed to load history')}</div>`;
      return;
    }
    tgHistoryCache = r.history || [];
    tgRenderThread();
  } catch (e) {
    if (thread) thread.innerHTML = `<div class="tg-empty">${esc(e.message)}</div>`;
  }
}

function tgRenderThread() {
  const thread = document.getElementById('tg-thread');
  if (!thread) return;
  const chat = tgChatsCache.find(c => String(c.chatId) === String(tgCurrentChatId));
  const header = `
    <div class="tg-thread-head">
      <div style="display:flex;align-items:center;gap:10px">
        ${_tgAvatar(chat || { chatId: tgCurrentChatId })}
        <div>
          <div style="font-size:13px;font-weight:700;color:var(--tx)">${esc(chat?.title || chat?.user || 'Chat ' + tgCurrentChatId)}</div>
          <div style="font-size:10px;color:var(--t3)">${esc(String(tgCurrentChatId))}${chat?.count ? ` · ${chat.count} messages stored` : ''}</div>
        </div>
      </div>
      <button class="hub-btn remove" onclick="tgClearCurrent()" title="Wipe local history for this chat">Clear local</button>
    </div>
    <div class="tg-msgs" id="tg-msgs"></div>
    <div class="tg-composer">
      <textarea id="tg-draft" placeholder="Reply as Horizon (sent via bot)…" rows="2"></textarea>
      <button class="hub-btn primary" onclick="tgSendDraft()">Send</button>
    </div>
  `;
  thread.innerHTML = header;
  const msgs = document.getElementById('tg-msgs');
  for (const entry of tgHistoryCache) _tgAppendMessage(entry, msgs);
  msgs.scrollTop = msgs.scrollHeight;
}

function _tgAppendMessage(entry, host) {
  host = host || document.getElementById('tg-msgs');
  if (!host) return;
  const role = entry.role === 'assistant' ? 'a' : 'u';
  const sourceTag = entry.source === 'desktop-ui'
    ? '<span class="tg-tag tg-tag-dt">desktop</span>'
    : entry.source === 'telegram-runtime'
      ? '<span class="tg-tag tg-tag-bot">bot</span>'
      : '';
  const meta = [entry.name, entry.provider && `${entry.provider}/${entry.model || ''}`].filter(Boolean).join(' · ');
  const when = _tgFmtTime(entry.at);
  host.insertAdjacentHTML('beforeend', `
    <div class="tg-msg tg-msg-${role}">
      <div class="tg-msg-meta">${esc(meta)} ${sourceTag} <span class="tg-msg-when">${when}</span></div>
      <div class="tg-msg-bubble">${esc(entry.content || '').replace(/\n/g, '<br>')}</div>
    </div>
  `);
  host.scrollTop = host.scrollHeight;
}

async function tgSendDraft() {
  const ta = document.getElementById('tg-draft');
  const text = (ta?.value || '').trim();
  if (!text || !tgCurrentChatId) return;
  ta.disabled = true;
  try {
    const r = await H.tgSendFromUI(tgCurrentChatId, text);
    if (r?.ok) {
      ta.value = '';
      // The bridge event will refresh the thread; no manual append needed.
    } else {
      H.notify?.('Telegram', r?.error || 'Send failed');
    }
  } catch (e) {
    H.notify?.('Telegram', e.message);
  } finally {
    ta.disabled = false;
    ta.focus();
  }
}

async function tgClearCurrent() {
  if (!tgCurrentChatId) return;
  const ok = await customConfirm?.(`Clear local history for chat ${tgCurrentChatId}? Telegram's server copy is not affected.`, 'Clear');
  if (!ok) return;
  try {
    const r = await H.tgClearHistory(tgCurrentChatId);
    if (r?.ok) {
      tgHistoryCache = [];
      tgRenderThread();
      tgRefreshChats();
    } else {
      H.notify?.('Telegram', r?.error || 'Clear failed');
    }
  } catch (e) {
    H.notify?.('Telegram', e.message);
  }
}
