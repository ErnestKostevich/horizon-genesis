'use strict';

const fetch = require('node-fetch');

const CONNECTIONS = [
  {
    id: 'slack',
    keyId: 'slack',
    name: 'Slack',
    envHint: 'xoxb-...',
    tools: [
      {
        name: 'conn_slack_list_channels',
        desc: '[Connection: Slack] List public channels visible to the bot token.',
        params: { limit: 'number optional' }
      },
      {
        name: 'conn_slack_post_message',
        desc: '[Connection: Slack] Post a message to a Slack channel. Requires permission approval.',
        params: { channel: 'string channel id or name', text: 'string' }
      }
    ]
  },
  {
    id: 'notion',
    keyId: 'notion',
    name: 'Notion',
    envHint: 'secret_...',
    tools: [
      {
        name: 'conn_notion_search',
        desc: '[Connection: Notion] Search pages/databases shared with the integration.',
        params: { query: 'string', limit: 'number optional' }
      },
      {
        name: 'conn_notion_create_page',
        desc: '[Connection: Notion] Create a page under a parent page/database. Requires permission approval.',
        params: { parentId: 'string', title: 'string', content: 'string optional' }
      }
    ]
  },
  {
    id: 'linear',
    keyId: 'linear',
    name: 'Linear',
    envHint: 'lin_api_...',
    tools: [
      {
        name: 'conn_linear_list_issues',
        desc: '[Connection: Linear] List recent Linear issues.',
        params: { query: 'string optional', limit: 'number optional' }
      },
      {
        name: 'conn_linear_create_issue',
        desc: '[Connection: Linear] Create a Linear issue in a team. Requires permission approval.',
        params: { teamId: 'string', title: 'string', description: 'string optional' }
      }
    ]
  },
  {
    id: 'telegram_bot',
    keyId: 'telegram_bot',
    name: 'Telegram Bot',
    envHint: '123456:ABC...',
    tools: [
      {
        name: 'conn_telegram_get_updates',
        desc: '[Connection: Telegram] Read recent bot updates.',
        params: { limit: 'number optional', offset: 'number optional' }
      },
      {
        name: 'conn_telegram_send_message',
        desc: '[Connection: Telegram] Send a message through the bot. Requires permission approval.',
        params: { chatId: 'string or number', text: 'string' }
      }
    ]
  }
];

function asText(value, limit = 16000) {
  return String(value == null ? '' : value).slice(0, limit);
}

function jsonOut(value, limit = 16000) {
  return JSON.stringify(value, null, 2).slice(0, limit);
}

async function readJson(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch (_) { return { raw: text }; }
}

class ConnectionsManager {
  constructor(keysStore, settingsStore) {
    this.keysStore = keysStore;
    this.settingsStore = settingsStore;
    this.replyFn = null;
    this.eventBridge = null;
    this.telegramPollAbort = null;
    this.telegramRunning = false;
    this.telegramLoopPromise = null;
    this.telegramLastError = '';
    this.telegramLastEventAt = '';
  }

  setReplyFn(fn) {
    this.replyFn = typeof fn === 'function' ? fn : null;
  }

  setEventBridge(fn) {
    this.eventBridge = typeof fn === 'function' ? fn : null;
  }

  token(id) {
    return this.keysStore?.get?.(`k_${id}`) || '';
  }

  has(id) {
    return Boolean(this.token(id));
  }

  list() {
    return CONNECTIONS.map(c => ({
      id: c.id,
      name: c.name,
      connected: this.has(c.keyId),
      envHint: c.envHint,
      toolCount: c.tools.length,
      liveSupported: c.id === 'telegram_bot',
      liveEnabled: c.id === 'telegram_bot' ? this.telegramLiveEnabled() : false,
      liveRunning: c.id === 'telegram_bot' ? this.telegramRunning : false,
      lastError: c.id === 'telegram_bot' ? this.telegramLastError : '',
      lastEventAt: c.id === 'telegram_bot' ? this.telegramLastEventAt : '',
    }));
  }

  toolsForAgent() {
    return CONNECTIONS
      .filter(c => this.has(c.keyId))
      .flatMap(c => c.tools.map(t => ({ ...t, connectionId: c.id })));
  }

  async testConnection(id) {
    if (id === 'slack') return this.slackApi('auth.test', {});
    if (id === 'notion') return this.notionSearch('', 1);
    if (id === 'linear') return this.linearGraphql('{ viewer { id name } }');
    if (id === 'telegram_bot') return this.telegramApi('getMe', {});
    return { ok: false, error: `Unknown connection: ${id}` };
  }

  telegramLiveEnabled() {
    return this.settingsStore?.get?.('connection.telegram_bot.live') === true;
  }

  _emitConnectionsUpdated() {
    try { this.eventBridge?.('connectionsUpdated', { connections: this.list() }); } catch (_) {}
  }

  telegramLog(message, type = 'info') {
    const line = { time: new Date().toISOString(), type, message: asText(message, 1000) };
    const logs = Array.isArray(this.settingsStore?.get?.('connection.telegram_bot.logs'))
      ? this.settingsStore.get('connection.telegram_bot.logs')
      : [];
    logs.push(line);
    this.settingsStore?.set?.('connection.telegram_bot.logs', logs.slice(-120));
    if (type === 'error') this.telegramLastError = line.message;
    this.telegramLastEventAt = line.time;
    this._emitConnectionsUpdated();
  }

  telegramStatus() {
    return {
      ok: true,
      enabled: this.telegramLiveEnabled(),
      running: this.telegramRunning,
      connected: this.has('telegram_bot'),
      lastError: this.telegramLastError,
      lastEventAt: this.telegramLastEventAt,
      offset: this.settingsStore?.get?.('connection.telegram_bot.offset') || 0,
      logs: (this.settingsStore?.get?.('connection.telegram_bot.logs') || []).slice(-50),
    };
  }

  async setTelegramLive(enabled) {
    this.settingsStore?.set?.('connection.telegram_bot.live', !!enabled);
    if (enabled) return this.startTelegramRuntime();
    await this.stopTelegramRuntime();
    return this.telegramStatus();
  }

  async startTelegramRuntime() {
    if (!this.has('telegram_bot')) {
      this.settingsStore?.set?.('connection.telegram_bot.live', false);
      return { ok: false, error: 'Telegram bot token is not configured.' };
    }
    if (!this.replyFn) {
      return { ok: false, error: 'AI reply function is not wired.' };
    }
    if (this.telegramRunning) return this.telegramStatus();
    this.telegramPollAbort = new AbortController();
    this.telegramRunning = true;
    this.telegramLastError = '';
    this.telegramLog('Telegram live replies started.', 'run');
    this.telegramLoopPromise = this.telegramLoop(this.telegramPollAbort.signal)
      .catch(e => {
        if (!this.telegramPollAbort?.signal?.aborted) {
          this.telegramLastError = e?.message || String(e);
          this.telegramLog(this.telegramLastError, 'error');
        }
      })
      .finally(() => {
        this.telegramRunning = false;
        this._emitConnectionsUpdated();
      });
    this._emitConnectionsUpdated();
    return this.telegramStatus();
  }

  async stopTelegramRuntime() {
    if (this.telegramPollAbort) {
      try { this.telegramPollAbort.abort(); } catch (_) {}
    }
    this.telegramPollAbort = null;
    this.telegramRunning = false;
    this.telegramLog('Telegram live replies stopped.', 'run');
    this._emitConnectionsUpdated();
    return this.telegramStatus();
  }

  async startEnabledRuntimes() {
    if (this.telegramLiveEnabled()) {
      const r = await this.startTelegramRuntime();
      if (!r.ok) this.telegramLog(r.error || 'Could not start Telegram runtime.', 'error');
    }
  }

  async telegramLoop(signal) {
    while (!signal.aborted && this.telegramLiveEnabled()) {
      const offset = Number(this.settingsStore?.get?.('connection.telegram_bot.offset') || 0) || undefined;
      let r;
      try {
        r = await this.telegramGetUpdates(20, offset, 25, signal);
      } catch (e) {
        if (signal.aborted) break;
        this.telegramLog(`Telegram polling failed: ${e?.message || e}`, 'error');
        await sleep(3000, signal);
        continue;
      }
      if (!r?.ok) {
        this.telegramLog(r?.err || r?.error || 'Telegram polling failed.', 'error');
        await sleep(3000, signal);
        continue;
      }
      const updates = Array.isArray(r.data) ? r.data : [];
      for (const update of updates) {
        const nextOffset = Number(update?.update_id) + 1;
        if (Number.isFinite(nextOffset)) this.settingsStore?.set?.('connection.telegram_bot.offset', nextOffset);
        await this.handleTelegramUpdate(update, signal);
      }
    }
  }

  // ── Telegram chat memory ───────────────────────────────────────────────
  // Storage layout in settingsStore (plain JSON in userData — same locality
  // as keys, just not encrypted since chat content rarely qualifies as a
  // secret; users who want crypto-grade privacy should disable the runtime):
  //   connection.telegram_bot.chats          → [{chatId,title,user,lastMsg,lastMsgAt,count}]
  //   connection.telegram_bot.history.<chatId> → [{role,content,at,name?}] (cap 400)
  // 400 messages × ~200 chars ≈ 80 KB per chat — comfortable for years of casual use.
  TG_HISTORY_CAP = 400;
  TG_CTX_FOR_MODEL = 16; // how many recent messages to pass into the model

  _tgHistoryKey(chatId) { return `connection.telegram_bot.history.${chatId}`; }

  _tgReadHistory(chatId) {
    const raw = this.settingsStore?.get?.(this._tgHistoryKey(chatId));
    return Array.isArray(raw) ? raw : [];
  }

  _tgWriteHistory(chatId, history) {
    const capped = history.slice(-this.TG_HISTORY_CAP);
    this.settingsStore?.set?.(this._tgHistoryKey(chatId), capped);
    return capped;
  }

  _tgUpdateChatMeta(chatId, patch) {
    const list = Array.isArray(this.settingsStore?.get?.('connection.telegram_bot.chats'))
      ? this.settingsStore.get('connection.telegram_bot.chats').slice()
      : [];
    const idx = list.findIndex(c => String(c.chatId) === String(chatId));
    const prev = idx >= 0 ? list[idx] : { chatId, count: 0 };
    const next = { ...prev, ...patch, chatId };
    if (idx >= 0) list[idx] = next; else list.push(next);
    // Keep most-recent first
    list.sort((a, b) => (new Date(b.lastMsgAt || 0).getTime()) - (new Date(a.lastMsgAt || 0).getTime()));
    this.settingsStore?.set?.('connection.telegram_bot.chats', list.slice(0, 200));
    return next;
  }

  telegramListChats() {
    const list = Array.isArray(this.settingsStore?.get?.('connection.telegram_bot.chats'))
      ? this.settingsStore.get('connection.telegram_bot.chats')
      : [];
    return { ok: true, chats: list };
  }

  telegramGetHistory(chatId, limit) {
    if (!chatId) return { ok: false, error: 'chatId required' };
    const hist = this._tgReadHistory(chatId);
    const lim = Math.max(1, Math.min(this.TG_HISTORY_CAP, Number(limit) || 200));
    return { ok: true, chatId, history: hist.slice(-lim), total: hist.length };
  }

  telegramClearHistory(chatId) {
    if (chatId) {
      this.settingsStore?.set?.(this._tgHistoryKey(chatId), []);
      const list = Array.isArray(this.settingsStore?.get?.('connection.telegram_bot.chats'))
        ? this.settingsStore.get('connection.telegram_bot.chats').filter(c => String(c.chatId) !== String(chatId))
        : [];
      this.settingsStore?.set?.('connection.telegram_bot.chats', list);
      try { this.eventBridge?.('telegram:chats', { chats: list }); } catch (_) {}
      return { ok: true, cleared: chatId };
    }
    // Clear everything: enumerate keys via the chats list (settingsStore
    // doesn't support prefix scans).
    const list = this.settingsStore?.get?.('connection.telegram_bot.chats') || [];
    for (const c of list) this.settingsStore?.set?.(this._tgHistoryKey(c.chatId), []);
    this.settingsStore?.set?.('connection.telegram_bot.chats', []);
    try { this.eventBridge?.('telegram:chats', { chats: [] }); } catch (_) {}
    return { ok: true, cleared: 'all' };
  }

  /** Public: ingest a manual outbound message sent from the desktop UI so it
   * lands in history exactly like a bot-sent reply. Used by the Telegram
   * chat viewer's "send" composer. */
  async telegramSendFromUI(chatId, text) {
    if (!chatId) return { ok: false, error: 'chatId required' };
    const trimmed = asText(text, 3900);
    if (!trimmed) return { ok: false, error: 'empty text' };
    const sent = await this.telegramSendMessage(chatId, trimmed);
    if (!sent?.ok) return sent;
    const entry = { role: 'assistant', content: trimmed, at: new Date().toISOString(), source: 'desktop-ui' };
    const next = this._tgWriteHistory(chatId, [...this._tgReadHistory(chatId), entry]);
    this._tgUpdateChatMeta(chatId, { lastMsg: trimmed.slice(0, 160), lastMsgAt: entry.at, count: (next.length) });
    try { this.eventBridge?.('telegram:message', { chatId, entry }); } catch (_) {}
    return { ok: true, entry };
  }

  async handleTelegramUpdate(update, signal) {
    const msg = update?.message || update?.edited_message;
    const text = String(msg?.text || '').trim();
    const chatId = msg?.chat?.id;
    if (!text || !chatId || msg?.from?.is_bot) return;
    this.telegramLog(`Incoming message from ${chatId}: ${text.slice(0, 120)}`, 'message');
    const user = msg?.from?.username || [msg?.from?.first_name, msg?.from?.last_name].filter(Boolean).join(' ') || 'Telegram user';
    const chatTitle = msg?.chat?.title || msg?.chat?.username || [msg?.chat?.first_name, msg?.chat?.last_name].filter(Boolean).join(' ') || `chat ${chatId}`;
    const now = new Date().toISOString();

    // Persist the inbound message FIRST so the chat viewer shows it even if
    // we hit /start, /status, or the AI reply fails.
    const userEntry = { role: 'user', content: text, at: now, name: user };
    const histAfterUser = this._tgWriteHistory(chatId, [...this._tgReadHistory(chatId), userEntry]);
    this._tgUpdateChatMeta(chatId, { title: chatTitle, user, lastMsg: text.slice(0, 160), lastMsgAt: now, count: histAfterUser.length });
    try { this.eventBridge?.('telegram:message', { chatId, entry: userEntry }); } catch (_) {}

    if (/^\/start(?:\s|$)/i.test(text)) {
      await this.telegramSendFromUI(chatId, 'Horizon is online. Send a message and I will reply through your selected Horizon model.');
      return;
    }
    if (/^\/status(?:\s|$)/i.test(text)) {
      await this.telegramSendFromUI(chatId, `Horizon Telegram runtime: ${this.telegramRunning ? 'online' : 'offline'}.`);
      return;
    }
    await this.telegramApi('sendChatAction', { chat_id: chatId, action: 'typing' }, signal).catch(() => {});
    // Build the model context from the LAST N entries (not from the full
    // 400-message history — we don't want to blow the context window). Each
    // entry's {role, content} subset is what the model expects.
    const recent = this._tgReadHistory(chatId).slice(-this.TG_CTX_FOR_MODEL);
    const messages = recent.map(({ role, content }) => ({ role, content }));
    const system = [
      'You are Horizon AI replying inside Telegram.',
      `Telegram user: ${user}. Chat id: ${chatId}.`,
      'Keep replies concise, useful, and plain text. Do not mention implementation details unless asked.',
      'If the user asks for desktop actions, explain that Telegram can chat and send connection tools, while destructive desktop actions require Horizon app approval.',
    ].join('\n');
    const res = await this.replyFn({ messages, system, source: 'telegram', chatId, signal });
    if (signal.aborted) return;
    const reply = asText(res?.reply || res?.text || res?.error || 'No response', 3900);
    const sendResult = await this.telegramSendMessage(chatId, reply || 'No response');
    const replyAt = new Date().toISOString();
    const assistantEntry = { role: 'assistant', content: reply, at: replyAt, source: 'telegram-runtime', provider: res?.provider, model: res?.model, ok: !!sendResult?.ok };
    const histAfterReply = this._tgWriteHistory(chatId, [...this._tgReadHistory(chatId), assistantEntry]);
    this._tgUpdateChatMeta(chatId, { lastMsg: reply.slice(0, 160), lastMsgAt: replyAt, count: histAfterReply.length });
    try { this.eventBridge?.('telegram:message', { chatId, entry: assistantEntry }); } catch (_) {}
    this.telegramLog(`Replied to ${chatId} via ${res?.provider || 'provider'} / ${res?.model || 'model'}`, 'reply');
  }

  async dispatch(toolName, args = {}) {
    switch (toolName) {
      case 'conn_slack_list_channels':
        return this.slackListChannels(args.limit);
      case 'conn_slack_post_message':
        return this.slackPostMessage(args.channel, args.text);
      case 'conn_notion_search':
        return this.notionSearch(args.query, args.limit);
      case 'conn_notion_create_page':
        return this.notionCreatePage(args.parentId, args.title, args.content);
      case 'conn_linear_list_issues':
        return this.linearListIssues(args.query, args.limit);
      case 'conn_linear_create_issue':
        return this.linearCreateIssue(args.teamId, args.title, args.description);
      case 'conn_telegram_get_updates':
        return this.telegramGetUpdates(args.limit, args.offset);
      case 'conn_telegram_send_message':
        return this.telegramSendMessage(args.chatId, args.text);
      default:
        return null;
    }
  }

  async slackApi(method, body) {
    const token = this.token('slack');
    if (!token) return { ok: false, err: 'Slack token is not configured in Settings -> Connections.' };
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body || {})
    });
    const data = await readJson(res);
    if (!res.ok || data.ok === false) return { ok: false, err: data.error || `Slack HTTP ${res.status}`, data };
    return { ok: true, out: jsonOut(data), data };
  }

  async slackListChannels(limit = 50) {
    const token = this.token('slack');
    if (!token) return { ok: false, err: 'Slack token is not configured.' };
    const params = new URLSearchParams({ limit: String(Math.min(Math.max(Number(limit) || 50, 1), 200)), types: 'public_channel,private_channel' });
    const res = await fetch(`https://slack.com/api/conversations.list?${params}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await readJson(res);
    if (!res.ok || data.ok === false) return { ok: false, err: data.error || `Slack HTTP ${res.status}`, data };
    const channels = (data.channels || []).map(c => ({ id: c.id, name: c.name, is_private: c.is_private, member: c.is_member }));
    return { ok: true, out: jsonOut(channels), channels };
  }

  async slackPostMessage(channel, text) {
    return this.slackApi('chat.postMessage', { channel: asText(channel, 120), text: asText(text, 4000) });
  }

  async notionSearch(query = '', limit = 10) {
    const token = this.token('notion');
    if (!token) return { ok: false, err: 'Notion token is not configured.' };
    const res = await fetch('https://api.notion.com/v1/search', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
      },
      body: JSON.stringify({ query: asText(query, 200), page_size: Math.min(Math.max(Number(limit) || 10, 1), 50) })
    });
    const data = await readJson(res);
    if (!res.ok) return { ok: false, err: data.message || `Notion HTTP ${res.status}`, data };
    const results = (data.results || []).map(item => ({
      id: item.id,
      object: item.object,
      url: item.url,
      title: extractNotionTitle(item)
    }));
    return { ok: true, out: jsonOut(results), results };
  }

  async notionCreatePage(parentId, title, content = '') {
    const token = this.token('notion');
    if (!token) return { ok: false, err: 'Notion token is not configured.' };
    const parent = String(parentId || '').replace(/-/g, '');
    if (!parent) return { ok: false, err: 'parentId is required.' };
    const body = {
      parent: { page_id: parentId },
      properties: {
        title: { title: [{ text: { content: asText(title || 'Untitled', 200) } }] }
      },
      children: content ? [{
        object: 'block',
        type: 'paragraph',
        paragraph: { rich_text: [{ type: 'text', text: { content: asText(content, 1800) } }] }
      }] : []
    };
    const res = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
      },
      body: JSON.stringify(body)
    });
    const data = await readJson(res);
    if (!res.ok) return { ok: false, err: data.message || `Notion HTTP ${res.status}`, data };
    return { ok: true, out: `Created Notion page: ${data.url || data.id}`, data };
  }

  async linearGraphql(query, variables = {}) {
    const token = this.token('linear');
    if (!token) return { ok: false, err: 'Linear API key is not configured.' };
    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables })
    });
    const data = await readJson(res);
    if (!res.ok || data.errors) return { ok: false, err: data.errors?.[0]?.message || `Linear HTTP ${res.status}`, data };
    return { ok: true, out: jsonOut(data.data), data: data.data };
  }

  async linearListIssues(queryText = '', limit = 20) {
    const first = Math.min(Math.max(Number(limit) || 20, 1), 50);
    const q = `
      query Issues($first: Int!, $filter: IssueFilter) {
        issues(first: $first, filter: $filter, orderBy: updatedAt) {
          nodes { id identifier title url state { name } team { key name } updatedAt }
        }
      }`;
    const variables = { first };
    if (queryText) variables.filter = { title: { containsIgnoreCase: asText(queryText, 120) } };
    const r = await this.linearGraphql(q, variables);
    if (!r.ok) return r;
    const issues = r.data?.issues?.nodes || [];
    return { ok: true, out: jsonOut(issues), issues };
  }

  async linearCreateIssue(teamId, title, description = '') {
    const q = `
      mutation IssueCreate($input: IssueCreateInput!) {
        issueCreate(input: $input) { success issue { id identifier title url } }
      }`;
    const r = await this.linearGraphql(q, {
      input: { teamId: asText(teamId, 80), title: asText(title, 240), description: asText(description, 4000) }
    });
    if (!r.ok) return r;
    return { ok: true, out: jsonOut(r.data?.issueCreate || {}), data: r.data?.issueCreate };
  }

  async telegramApi(method, body, signal) {
    const token = this.token('telegram_bot');
    if (!token) return { ok: false, err: 'Telegram bot token is not configured.' };
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal,
    });
    const data = await readJson(res);
    if (!res.ok || data.ok === false) return { ok: false, err: data.description || `Telegram HTTP ${res.status}`, data };
    return { ok: true, out: jsonOut(data.result), data: data.result };
  }

  async telegramGetUpdates(limit = 20, offset = undefined, timeout = 0, signal) {
    const body = { limit: Math.min(Math.max(Number(limit) || 20, 1), 100), timeout: Math.max(0, Math.min(Number(timeout) || 0, 50)) };
    if (Number.isFinite(Number(offset))) body.offset = Number(offset);
    return this.telegramApi('getUpdates', body, signal);
  }

  async telegramSendMessage(chatId, text) {
    return this.telegramApi('sendMessage', { chat_id: chatId, text: asText(text, 4000) });
  }
}

function sleep(ms, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

function extractNotionTitle(item) {
  const props = item?.properties || {};
  for (const value of Object.values(props)) {
    const rich = value?.title || value?.rich_text;
    if (Array.isArray(rich) && rich.length) {
      const text = rich.map(part => part?.plain_text || part?.text?.content || '').join('').trim();
      if (text) return text;
    }
  }
  return item?.object || item?.id || 'Untitled';
}

module.exports = { ConnectionsManager, CONNECTIONS };
