'use strict';
/**
 * Horizon Discord Gateway client — minimal WS implementation.
 *
 * Speaks just enough of Discord's Gateway v10 to:
 *   - Authenticate with Bot token + the GUILDS, GUILD_MESSAGES, and
 *     MESSAGE_CONTENT intents (last one is privileged — the user must
 *     enable it in the Developer Portal under the bot's settings).
 *   - Receive READY, GUILD_CREATE, MESSAGE_CREATE events.
 *   - Maintain heartbeat (op 1) on the schedule the server gives us.
 *   - Auto-reconnect with bounded exponential backoff (max ~60s).
 *   - Resume after transient drops where possible (RESUME op 6).
 *
 * Not implemented (yet): SHARDING (single shard is fine for <2500 guilds),
 * VOICE, presence updates, command interactions. We never SEND anything
 * through the Gateway — message replies go through the REST adapter in
 * connectionsManager.js (already shipped).
 *
 * Designed to be cheap when idle: a single open WS + a timer. Total
 * memory overhead < 1MB.
 */

const { EventEmitter } = require('events');

const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';

// https://discord.com/developers/docs/topics/gateway#list-of-intents
const INTENTS = {
  GUILDS: 1 << 0,
  GUILD_MESSAGES: 1 << 9,
  MESSAGE_CONTENT: 1 << 15,   // privileged — must be enabled in dev portal
  DIRECT_MESSAGES: 1 << 12,
};

const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
};

const MAX_BACKOFF_MS = 60_000;

function tryRequireWs() {
  try { return require('ws'); }
  catch (e) {
    return null;
  }
}

class DiscordGateway extends EventEmitter {
  constructor({ token, intents }) {
    super();
    this.token = String(token || '');
    this.intents = typeof intents === 'number'
      ? intents
      : (INTENTS.GUILDS | INTENTS.GUILD_MESSAGES | INTENTS.MESSAGE_CONTENT | INTENTS.DIRECT_MESSAGES);
    this.ws = null;
    this.heartbeatTimer = null;
    this.sequence = null;
    this.sessionId = null;
    this.resumeGatewayUrl = null;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.closed = true;
    this.lastError = '';
    this.lastEventAt = null;
    // Cache discovered guilds + channels so the renderer chat viewer can
    // show human names. Populated by GUILD_CREATE / CHANNEL_UPDATE.
    this.guilds = new Map();   // guildId → { id, name, channels: Map(channelId → {id, name, type, guildId, guildName}) }
    this.channels = new Map(); // channelId → channel record (shortcut)
  }

  isOpen() {
    return Boolean(this.ws) && !this.closed;
  }

  async connect() {
    const WS = tryRequireWs();
    if (!WS) {
      this.lastError = '`ws` package not installed. Run `npm install ws` in the horizon-genesis folder and restart the app.';
      this.emit('error', new Error(this.lastError));
      return false;
    }
    if (!this.token) {
      this.lastError = 'Discord bot token is empty.';
      this.emit('error', new Error(this.lastError));
      return false;
    }
    this.closed = false;
    const url = this.resumeGatewayUrl || GATEWAY_URL;
    try {
      this.ws = new WS(url);
    } catch (e) {
      this.lastError = 'gateway connect failed: ' + e.message;
      this._scheduleReconnect();
      return false;
    }
    this.ws.on('open', () => {
      this.reconnectAttempts = 0;
      this.emit('open');
    });
    this.ws.on('message', (raw) => {
      let payload;
      try { payload = JSON.parse(raw.toString()); } catch (_) { return; }
      this._handlePayload(payload);
    });
    this.ws.on('close', (code, reason) => {
      this._cleanupHeartbeat();
      this.lastError = `gateway closed: ${code}${reason ? ' — ' + String(reason).slice(0, 200) : ''}`;
      this.emit('close', { code, reason: String(reason || '') });
      // 4004 = auth failed (bad token), 4014 = disallowed intent → do NOT retry.
      // 4013 = invalid intent → do NOT retry. Other codes get backoff.
      if (this.closed) return;
      if (code === 4004 || code === 4013 || code === 4014) {
        this.lastError = `Discord auth/intent error (${code}). Check your bot token and that MESSAGE_CONTENT intent is enabled in the Developer Portal.`;
        this.emit('fatal', { code, message: this.lastError });
        return;
      }
      this._scheduleReconnect();
    });
    this.ws.on('error', (err) => {
      this.lastError = 'gateway error: ' + (err?.message || err);
      this.emit('error', err);
    });
    return true;
  }

  disconnect() {
    this.closed = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this._cleanupHeartbeat();
    try { this.ws?.close(1000, 'client disconnect'); } catch (_) {}
    this.ws = null;
  }

  _scheduleReconnect() {
    if (this.closed) return;
    this.reconnectAttempts = Math.min(10, (this.reconnectAttempts || 0) + 1);
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * Math.pow(2, this.reconnectAttempts - 1));
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      if (!this.closed) this.connect();
    }, delay);
  }

  _cleanupHeartbeat() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  _handlePayload(payload) {
    const { op, t, s, d } = payload;
    if (typeof s === 'number') this.sequence = s;
    this.lastEventAt = new Date().toISOString();

    switch (op) {
      case OP.HELLO: {
        // Server tells us how often to heartbeat. Send first beat after a
        // random jitter to avoid synchronised reconnect storms.
        const interval = Math.max(5000, Number(d?.heartbeat_interval) || 41250);
        const jitter = Math.random() * interval;
        setTimeout(() => this._sendHeartbeat(), jitter);
        this.heartbeatTimer = setInterval(() => this._sendHeartbeat(), interval);
        // If we have a session, resume; otherwise identify fresh.
        if (this.sessionId && this.sequence !== null) {
          this._send(OP.RESUME, { token: this.token, session_id: this.sessionId, seq: this.sequence });
        } else {
          this._send(OP.IDENTIFY, {
            token: this.token,
            intents: this.intents,
            properties: { os: process.platform, browser: 'horizon-genesis', device: 'horizon-genesis' },
            compress: false,
            large_threshold: 50,
          });
        }
        break;
      }
      case OP.HEARTBEAT: {
        // Server asked us to beat early.
        this._sendHeartbeat();
        break;
      }
      case OP.RECONNECT: {
        // Server asks us to reconnect (resume if possible).
        try { this.ws?.close(4000, 'server requested reconnect'); } catch (_) {}
        break;
      }
      case OP.INVALID_SESSION: {
        // Resume failed — re-identify after a small delay per Discord docs.
        this.sessionId = null;
        this.sequence = null;
        setTimeout(() => {
          if (this.ws?.readyState === 1) {
            this._send(OP.IDENTIFY, {
              token: this.token,
              intents: this.intents,
              properties: { os: process.platform, browser: 'horizon-genesis', device: 'horizon-genesis' },
            });
          }
        }, 1000 + Math.random() * 4000);
        break;
      }
      case OP.HEARTBEAT_ACK: {
        // No-op, but useful for diagnostics if we ever add latency tracking.
        break;
      }
      case OP.DISPATCH: {
        this._handleDispatch(t, d);
        break;
      }
      default:
        // Other ops (presence updates etc.) we just ignore.
        break;
    }
  }

  _handleDispatch(t, d) {
    if (t === 'READY') {
      this.sessionId = d?.session_id || null;
      this.resumeGatewayUrl = d?.resume_gateway_url || null;
      this.emit('ready', { user: d?.user || null, guildCount: (d?.guilds || []).length });
      return;
    }
    if (t === 'RESUMED') {
      this.emit('resumed');
      return;
    }
    if (t === 'GUILD_CREATE' || t === 'GUILD_UPDATE') {
      const channels = new Map();
      for (const c of (d?.channels || [])) {
        // GUILD_TEXT(0), ANNOUNCEMENT(5), threads (10,11,12), FORUM(15).
        if ([0, 5, 10, 11, 12, 15].includes(c.type)) {
          const rec = { id: c.id, name: c.name, type: c.type, guildId: d.id, guildName: d.name };
          channels.set(c.id, rec);
          this.channels.set(c.id, rec);
        }
      }
      this.guilds.set(d.id, { id: d.id, name: d.name, channels });
      this.emit('guildUpdated', { id: d.id, name: d.name, channelCount: channels.size });
      return;
    }
    if (t === 'GUILD_DELETE') {
      const g = this.guilds.get(d?.id);
      if (g) {
        for (const cid of g.channels.keys()) this.channels.delete(cid);
        this.guilds.delete(d.id);
      }
      return;
    }
    if (t === 'CHANNEL_CREATE' || t === 'CHANNEL_UPDATE') {
      if (d?.id && d?.guild_id && [0, 5, 10, 11, 12, 15].includes(d.type)) {
        const g = this.guilds.get(d.guild_id);
        const rec = { id: d.id, name: d.name, type: d.type, guildId: d.guild_id, guildName: g?.name || '' };
        this.channels.set(d.id, rec);
        if (g) g.channels.set(d.id, rec);
      }
      return;
    }
    if (t === 'CHANNEL_DELETE') {
      if (d?.id) this.channels.delete(d.id);
      return;
    }
    if (t === 'MESSAGE_CREATE') {
      // Skip bot's own messages — the runtime sends replies via REST and
      // we'd otherwise loop on every reply.
      if (d?.author?.bot) return;
      const channel = this.channels.get(d?.channel_id);
      this.emit('message', {
        id: d.id,
        channelId: d.channel_id,
        guildId: d.guild_id || null,
        channelName: channel?.name || '',
        guildName: channel?.guildName || '',
        author: d.author?.username || d.author?.global_name || 'unknown',
        authorId: d.author?.id || '',
        content: String(d.content || ''),
        timestamp: d.timestamp || new Date().toISOString(),
        raw: d,
      });
      return;
    }
    // Other event types ignored.
  }

  _sendHeartbeat() {
    this._send(OP.HEARTBEAT, this.sequence);
  }

  _send(op, d) {
    if (!this.ws || this.ws.readyState !== 1) return;
    try { this.ws.send(JSON.stringify({ op, d })); }
    catch (e) { this.emit('error', e); }
  }

  listChannels() {
    return [...this.channels.values()];
  }

  listGuilds() {
    return [...this.guilds.values()].map(g => ({ id: g.id, name: g.name, channelCount: g.channels.size }));
  }

  status() {
    return {
      connected: this.isOpen(),
      sessionId: this.sessionId,
      sequence: this.sequence,
      reconnectAttempts: this.reconnectAttempts,
      guilds: this.guilds.size,
      channels: this.channels.size,
      lastError: this.lastError,
      lastEventAt: this.lastEventAt,
    };
  }
}

module.exports = { DiscordGateway, INTENTS, OP };
