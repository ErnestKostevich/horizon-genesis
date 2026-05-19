// Slack Socket Mode WebSocket client — Phase 21.
//
// Slack has two real-time options for receiving inbound messages:
//
//   1. Events API — HTTP webhooks. Requires a public endpoint (ngrok
//      or hosted backend), so it's hostile to a local desktop app.
//   2. Socket Mode — WebSocket. Slack initiates the connection FROM
//      slack.com, the app behind NAT/firewall is fine. This is the
//      right choice for Horizon.
//
// Socket Mode requires TWO tokens:
//   - `xoxb-…` bot token  — used to POST messages back (already in
//     keystore under `slack`)
//   - `xapp-…` app-level token with `connections:write` scope — used
//     to open the socket. New key slot: `slack_app`.
//
// Lifecycle: open → ack hello → receive envelopes → ack each →
// re-open URL on disconnect_warning → reconnect on close.
//
// Emits:
//   'ready'   ({ team, user })
//   'message' ({ channelId, channelName, teamId, user, text, ts })
//   'close'   ({ code, reason })
//   'error'   (err)

const WebSocket = require('ws');
const EventEmitter = require('events');

const APPS_CONNECTIONS_OPEN = 'https://slack.com/api/apps.connections.open';

class SlackSocketMode extends EventEmitter {
  constructor({ appToken, botToken }) {
    super();
    this.appToken = appToken;
    this.botToken = botToken;
    this.ws = null;
    this.shouldRun = false;
    this.reconnectTimer = null;
    this.teamCache = null;
    this.userCache = null;
    this.channelNameCache = new Map();
    this.lastError = null;
  }

  async connect() {
    if (this.shouldRun) return true;
    this.shouldRun = true;
    return await this._openSocket();
  }

  disconnect() {
    this.shouldRun = false;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) {
      try { this.ws.terminate(); } catch (_) {}
      this.ws = null;
    }
  }

  async _openSocket() {
    let wsUrl;
    try {
      const res = await fetch(APPS_CONNECTIONS_OPEN, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.appToken}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
      });
      const json = await res.json();
      if (!json.ok) {
        this.lastError = json.error || `HTTP ${res.status}`;
        this.emit('error', new Error('apps.connections.open failed: ' + this.lastError));
        return false;
      }
      wsUrl = json.url;
    } catch (e) {
      this.lastError = e.message;
      this.emit('error', e);
      return false;
    }

    try {
      this.ws = new WebSocket(wsUrl);
    } catch (e) {
      this.lastError = e.message;
      this.emit('error', e);
      return false;
    }

    this.ws.on('open', () => {
      this.emit('open');
    });

    this.ws.on('message', (raw) => {
      let env;
      try { env = JSON.parse(raw.toString()); } catch { return; }

      // Slack sends acknowledge_response only — we send back the envelope_id
      // so Slack knows we processed it. Otherwise Slack retries.
      if (env.envelope_id) {
        try { this.ws.send(JSON.stringify({ envelope_id: env.envelope_id })); } catch (_) {}
      }

      if (env.type === 'hello') {
        this.emit('ready', {
          team: env.connection_info?.team_id || null,
          user: env.connection_info?.bot_id || null,
        });
        return;
      }

      if (env.type === 'disconnect') {
        // Slack asks us to reconnect (rotation). Close cleanly; open() in
        // 'close' handler kicks in.
        try { this.ws.close(1000, 'slack-rotation'); } catch (_) {}
        return;
      }

      if (env.type === 'events_api' && env.payload?.event) {
        this._handleEvent(env.payload);
      }
    });

    this.ws.on('close', ({ code, reason } = {}) => {
      this.emit('close', { code, reason: String(reason || '') });
      if (this.shouldRun) {
        // Reconnect with backoff
        this.reconnectTimer = setTimeout(() => {
          if (this.shouldRun) this._openSocket();
        }, 2000);
      }
    });

    this.ws.on('error', (err) => {
      this.lastError = err?.message || String(err);
      this.emit('error', err);
    });

    return true;
  }

  _handleEvent(payload) {
    const ev = payload.event || {};

    // Only handle messages from users — skip bot messages (loop guard) and
    // edit/delete events.
    if (ev.type !== 'message') return;
    if (ev.subtype) return;             // skip bot_message, message_changed, etc.
    if (ev.bot_id) return;
    if (!ev.text || !ev.channel) return;

    this.emit('message', {
      channelId: ev.channel,
      channelName: this.channelNameCache.get(ev.channel) || `#${ev.channel}`,
      teamId: payload.team_id || null,
      user: ev.user,
      text: ev.text,
      ts: ev.ts,
      thread_ts: ev.thread_ts || null,
    });
  }

  cacheChannelName(channelId, name) {
    if (channelId && name) this.channelNameCache.set(channelId, name);
  }
}

module.exports = { SlackSocketMode };
