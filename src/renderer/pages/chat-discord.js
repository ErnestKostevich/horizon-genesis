// Discord chat viewer — mirrors chat-telegram.js but talks to dc* IPC.
// Bot's Gateway runtime in connectionsManager listens for MESSAGE_CREATE
// events; this panel shows the per-channel history that runtime persists,
// with live updates via H.onDiscordMessage.

var dcCurrentChannelId = null;
var dcChatsCache = [];
var dcHistoryCache = [];
var dcUnsubHandlers = [];
var dcListSubscribed = false;

function _dcFmtTime(iso) {
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

function _dcAvatar(chat) {
  const seed = String(chat?.channelName || chat?.guildName || chat?.channelId || '#').trim().charAt(0).toUpperCase() || '#';
  return `<div class="tg-avatar dc-avatar">${esc(seed)}</div>`;
}

function openDiscordHub() {
  setActiveSurface('discord', { keepPanels: ['discord-panel'] });
  document.getElementById('discord-panel').classList.add('show');
  _dcSubscribeListLive();
  dcRefreshChats();
}

function closeDiscordHub() {
  document.getElementById('discord-panel').classList.remove('show');
  if (isSurfaceActive('discord')) closeActiveSurface();
}

function _dcSubscribeListLive() {
  if (dcListSubscribed) return;
  dcListSubscribed = true;
  try {
    const offMsg = H.onDiscordMessage?.(({ channelId, entry }) => {
      dcRefreshChats();
      if (dcCurrentChannelId && String(dcCurrentChannelId) === String(channelId)) {
        dcHistoryCache.push(entry);
        _dcAppendMessage(entry);
      }
    });
    const offChats = H.onDiscordChats?.(() => { dcRefreshChats(); });
    if (offMsg) dcUnsubHandlers.push(offMsg);
    if (offChats) dcUnsubHandlers.push(offChats);
  } catch (_) {}
}

async function dcRefreshChats() {
  try {
    const r = await H.dcListChats();
    dcChatsCache = (r && r.ok && Array.isArray(r.chats)) ? r.chats : [];
    dcRenderList();
  } catch (e) {
    const list = document.getElementById('dc-chat-list');
    if (list) list.innerHTML = `<div class="tg-empty">Error: ${esc(e.message)}</div>`;
  }
}

function dcRenderList() {
  const list = document.getElementById('dc-chat-list');
  if (!list) return;
  if (!dcChatsCache.length) {
    list.innerHTML = `
      <div class="tg-empty">
        <div style="opacity:.5;margin-bottom:8px"><svg class="licon lg"><use href="#i-gamepad"/></svg></div>
        <strong>No Discord channels yet</strong>
        <p>Enable the Discord bot runtime in Settings → Connections, invite the bot to a server with MESSAGE_CONTENT intent, then send it a message in any text channel.</p>
      </div>`;
    return;
  }
  list.innerHTML = dcChatsCache.map(c => {
    const active = String(dcCurrentChannelId) === String(c.channelId) ? ' on' : '';
    const title = esc(c.channelName ? '#' + c.channelName : 'channel ' + c.channelId);
    const guild = esc(c.guildName || '');
    const preview = esc((c.lastMsg || '').slice(0, 80));
    const when = _dcFmtTime(c.lastMsgAt);
    const count = c.count ? `<span class="tg-row-count">${c.count}</span>` : '';
    return `
      <button class="tg-row${active}" onclick="dcSelectChannel('${esc(String(c.channelId))}')">
        ${_dcAvatar(c)}
        <div class="tg-row-body">
          <div class="tg-row-head">
            <span class="tg-row-title">${title}</span>
            <span class="tg-row-when">${when}</span>
          </div>
          ${guild ? `<div class="tg-row-preview" style="color:var(--t3);font-size:9px">${guild}</div>` : ''}
          <div class="tg-row-preview">${preview}</div>
        </div>
        ${count}
      </button>
    `;
  }).join('');
}

async function dcSelectChannel(channelId) {
  dcCurrentChannelId = channelId;
  dcRenderList();
  const thread = document.getElementById('dc-thread');
  if (thread) thread.innerHTML = '<div class="tg-empty" style="padding:20px">Loading history...</div>';
  try {
    const r = await H.dcGetHistory(channelId, 400);
    if (!r?.ok) {
      if (thread) thread.innerHTML = `<div class="tg-empty">${esc(r?.error || 'Failed to load history')}</div>`;
      return;
    }
    dcHistoryCache = r.history || [];
    dcRenderThread();
  } catch (e) {
    if (thread) thread.innerHTML = `<div class="tg-empty">${esc(e.message)}</div>`;
  }
}

function dcRenderThread() {
  const thread = document.getElementById('dc-thread');
  if (!thread) return;
  const chat = dcChatsCache.find(c => String(c.channelId) === String(dcCurrentChannelId));
  const header = `
    <div class="tg-thread-head">
      <div style="display:flex;align-items:center;gap:10px">
        ${_dcAvatar(chat || { channelId: dcCurrentChannelId })}
        <div>
          <div style="font-size:13px;font-weight:700;color:var(--tx)">${esc(chat?.channelName ? '#' + chat.channelName : 'Channel ' + dcCurrentChannelId)}</div>
          <div style="font-size:10px;color:var(--t3)">${esc(chat?.guildName || '')}${chat?.count ? ` · ${chat.count} messages stored` : ''}</div>
        </div>
      </div>
      <button class="hub-btn remove" onclick="dcClearCurrent()" title="Wipe local history">Clear local</button>
    </div>
    <div class="tg-msgs" id="dc-msgs"></div>
    <div class="tg-composer">
      <textarea id="dc-draft" placeholder="Reply as Horizon (sent via bot, max 2000 chars)…" rows="2"></textarea>
      <button class="hub-btn primary" onclick="dcSendDraft()">Send</button>
    </div>
  `;
  thread.innerHTML = header;
  const msgs = document.getElementById('dc-msgs');
  for (const entry of dcHistoryCache) _dcAppendMessage(entry, msgs);
  msgs.scrollTop = msgs.scrollHeight;
}

function _dcAppendMessage(entry, host) {
  host = host || document.getElementById('dc-msgs');
  if (!host) return;
  const role = entry.role === 'assistant' ? 'a' : 'u';
  const sourceTag = entry.source === 'desktop-ui'
    ? '<span class="tg-tag tg-tag-dt">desktop</span>'
    : entry.source === 'discord-runtime'
      ? '<span class="tg-tag tg-tag-bot">bot</span>'
      : '';
  const meta = [entry.name, entry.provider && `${entry.provider}/${entry.model || ''}`].filter(Boolean).join(' · ');
  const when = _dcFmtTime(entry.at);
  host.insertAdjacentHTML('beforeend', `
    <div class="tg-msg tg-msg-${role}">
      <div class="tg-msg-meta">${esc(meta)} ${sourceTag} <span class="tg-msg-when">${when}</span></div>
      <div class="tg-msg-bubble">${esc(entry.content || '').replace(/\n/g, '<br>')}</div>
    </div>
  `);
  host.scrollTop = host.scrollHeight;
}

async function dcSendDraft() {
  const ta = document.getElementById('dc-draft');
  const text = (ta?.value || '').trim();
  if (!text || !dcCurrentChannelId) return;
  ta.disabled = true;
  try {
    const r = await H.dcSendFromUI(dcCurrentChannelId, text);
    if (r?.ok) {
      ta.value = '';
    } else {
      H.notify?.('Discord', r?.error || 'Send failed');
    }
  } catch (e) {
    H.notify?.('Discord', e.message);
  } finally {
    ta.disabled = false;
    ta.focus();
  }
}

async function dcClearCurrent() {
  if (!dcCurrentChannelId) return;
  const ok = await customConfirm?.(`Clear local history for channel ${dcCurrentChannelId}? Discord's server copy is not affected.`, 'Clear');
  if (!ok) return;
  try {
    const r = await H.dcClearHistory(dcCurrentChannelId);
    if (r?.ok) {
      dcHistoryCache = [];
      dcRenderThread();
      dcRefreshChats();
    } else {
      H.notify?.('Discord', r?.error || 'Clear failed');
    }
  } catch (e) {
    H.notify?.('Discord', e.message);
  }
}
