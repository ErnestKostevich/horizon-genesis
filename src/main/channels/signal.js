// Signal adapter via signal-cli-rest-api (BYOK self-hosted bridge).
//
// Signal Messenger doesn't expose a public API by design. The standard
// workaround used by every Signal bot in the wild is `signal-cli`, the
// Java-based unofficial CLI client. signal-cli-rest-api wraps it in a
// Docker container exposing an HTTP API on localhost:8080.
//
// Setup user-side (one-time, ~10 min):
//   1. Install Docker.
//   2. `docker run -d --name signal-api --restart=always
//          -p 8080:8080 -v signal_data:/home/.local/share/signal-cli
//          bbernhard/signal-cli-rest-api:latest`
//   3. Register your phone number with Signal:
//        curl -X POST http://localhost:8080/v1/register/+1234567890
//        # wait for SMS or voice code, then:
//        curl -X POST http://localhost:8080/v1/register/+1234567890/verify/<code>
//   4. `horizon connect signal --url http://localhost:8080 --number +1234567890`
//
// Capabilities:
//   - send text + attachments
//   - receive via long-polling /v1/receive (Horizon's serve runtime
//     polls this on a 5s interval when --enable-signal is passed)
//   - group support (set groupId instead of recipients)

/**
 * Send a Signal message.
 *
 * @param {object} cfg   { url, number }
 * @param {object} args  { to: '+1234567890' or '+1234567890,+5...', text, attachments? }
 */
async function sendMessage(cfg, args) {
  if (!cfg.url || !cfg.number) {
    return { ok: false, error: 'Signal not configured. Use `horizon connect signal --url http://localhost:8080 --number +N`.' };
  }
  if (!args.to || !args.text) {
    return { ok: false, error: 'to + text required' };
  }
  const recipients = Array.isArray(args.to) ? args.to : String(args.to).split(',').map(s => s.trim()).filter(Boolean);
  const fetch = typeof globalThis.fetch === 'function' ? globalThis.fetch : require('node-fetch');
  try {
    const r = await fetch(`${cfg.url.replace(/\/$/, '')}/v2/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: args.text,
        number: cfg.number,
        recipients,
        ...(args.attachments ? { base64_attachments: args.attachments } : {}),
      }),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      return { ok: false, error: `signal HTTP ${r.status}: ${txt.slice(0, 200)}` };
    }
    const d = await r.json();
    return { ok: true, timestamp: d.timestamp, recipients };
  } catch (e) {
    return { ok: false, error: 'signal send failed: ' + e.message + ' (is signal-cli-rest-api running on ' + cfg.url + '?)' };
  }
}

/**
 * Pull pending Signal messages. Returns an array of normalised
 * channel-events. Designed to be called on a short interval (5s) by
 * the serve runtime when Signal is enabled.
 */
async function receiveMessages(cfg, opts = {}) {
  if (!cfg.url || !cfg.number) return { ok: false, messages: [] };
  const fetch = typeof globalThis.fetch === 'function' ? globalThis.fetch : require('node-fetch');
  try {
    const r = await fetch(`${cfg.url.replace(/\/$/, '')}/v1/receive/${encodeURIComponent(cfg.number)}`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      // signal-cli's receive blocks up to ~10s on long-poll
      signal: AbortSignal.timeout(Math.max(opts.timeoutMs || 12000, 5000)),
    });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const messages = await r.json();
    if (!Array.isArray(messages) || !messages.length) return { ok: true, messages: [] };
    return {
      ok: true,
      messages: messages.map(parseInboundMessage).filter(Boolean),
    };
  } catch (e) {
    // Timeout is expected when there's nothing — return empty
    if (e.name === 'AbortError' || e.name === 'TimeoutError') return { ok: true, messages: [] };
    return { ok: false, error: e.message };
  }
}

function parseInboundMessage(envelope) {
  if (!envelope?.envelope?.dataMessage) return null;
  const e = envelope.envelope;
  const d = e.dataMessage;
  const text = d.message || '';
  if (!text && !(d.groupInfo)) return null;
  return {
    chatId: d.groupInfo?.groupId || e.source,
    text,
    user: { id: e.source, name: e.sourceName || e.source },
    source: 'signal',
    groupId: d.groupInfo?.groupId || null,
    timestamp: d.timestamp || e.timestamp,
    raw: envelope,
  };
}

/**
 * Liveness probe — does signal-cli-rest-api answer on the configured
 * URL? Used by `horizon doctor` to flag misconfiguration.
 */
async function ping(cfg) {
  if (!cfg.url) return false;
  const fetch = typeof globalThis.fetch === 'function' ? globalThis.fetch : require('node-fetch');
  try {
    const r = await fetch(`${cfg.url.replace(/\/$/, '')}/v1/about`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch (_) { return false; }
}

module.exports = { sendMessage, receiveMessages, parseInboundMessage, ping };
