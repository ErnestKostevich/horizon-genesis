// WhatsApp adapter via Twilio Messages API (BYOK).
//
// Why Twilio: writing directly to Meta's WhatsApp Business Platform
// API requires a Facebook Business Manager + verified phone number +
// template message approval. Twilio gives you a free sandbox number
// in 5 minutes and the same Bearer-auth REST API as their SMS product.
//
// Setup user-side:
//   1. Sign up at twilio.com → Console → Messaging → Try WhatsApp.
//   2. Join the sandbox by sending "join <code>" from your phone to
//      the displayed sandbox number.
//   3. Copy AccountSID + AuthToken from the Console dashboard.
//   4. `horizon connect whatsapp --twilio-sid AC... --twilio-token X --from whatsapp:+14155238886`
//   5. (Optional) Configure the inbound webhook URL in Twilio to point
//      to `https://your-horizon-host/api/whatsapp/webhook` if you want
//      Horizon to receive incoming messages. Without the webhook,
//      sending still works one-way.
//
// Capabilities:
//   - send text message (this file)
//   - receive incoming text via webhook (handled in horizon-serve.js
//     /api/whatsapp/webhook endpoint)
//   - send media URLs (mediaUrl param)
//
// Tool name exposed to the agent: conn_whatsapp_send.
// Webhook events surface via the connectionsManager's eventBridge,
// same path as Telegram/Discord runtimes.

const crypto = require('node:crypto');

/**
 * Send a WhatsApp message through the user's Twilio account.
 *
 * @param {object} cfg
 * @param {string} cfg.accountSid    Twilio Account SID (starts with AC...)
 * @param {string} cfg.authToken     Twilio Auth Token
 * @param {string} cfg.from          Sender (e.g. "whatsapp:+14155238886")
 * @param {object} args
 * @param {string} args.to           Recipient (e.g. "whatsapp:+1234567890")
 * @param {string} args.text         Body text
 * @param {string} [args.mediaUrl]   Optional media attachment URL
 */
async function sendMessage(cfg, args) {
  if (!cfg.accountSid || !cfg.authToken || !cfg.from) {
    return { ok: false, error: 'WhatsApp not configured. Use `horizon connect whatsapp --twilio-sid X --twilio-token Y --from whatsapp:+N`.' };
  }
  if (!args.to || !args.text) {
    return { ok: false, error: 'to + text required' };
  }
  const fetch = typeof globalThis.fetch === 'function' ? globalThis.fetch : require('node-fetch');
  // Twilio uses application/x-www-form-urlencoded + HTTP Basic auth.
  const body = new URLSearchParams();
  body.set('From', args.from || cfg.from);
  body.set('To', args.to.startsWith('whatsapp:') ? args.to : 'whatsapp:' + args.to);
  body.set('Body', args.text);
  if (args.mediaUrl) body.set('MediaUrl', args.mediaUrl);
  const auth = Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString('base64');
  try {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Messages.json`, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + auth,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
    const d = await r.json();
    if (!r.ok || d.code) {
      return { ok: false, error: d.message || `HTTP ${r.status}`, twilioCode: d.code };
    }
    return { ok: true, messageSid: d.sid, status: d.status, to: d.to };
  } catch (e) {
    return { ok: false, error: 'whatsapp send failed: ' + e.message };
  }
}

/**
 * Verify a Twilio webhook signature so we don't accept spoofed
 * inbound messages. Twilio docs: HMAC-SHA1 over (url + sorted form
 * params concatenated), Base64-encoded, sent as X-Twilio-Signature.
 *
 * Skip verification by passing { skipVerify: true } in dev.
 */
function verifyWebhookSignature({ authToken, url, params, signature }) {
  if (!signature || !authToken) return false;
  // Sort + concat
  const keys = Object.keys(params).sort();
  let data = url;
  for (const k of keys) data += k + (params[k] || '');
  const expected = crypto.createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
  // Constant-time compare
  if (expected.length !== signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

/**
 * Parse a Twilio inbound webhook body into the unified channel-event
 * shape used by connectionsManager.handle*Update.
 *
 * Twilio sends application/x-www-form-urlencoded with fields:
 *   From, To, Body, MessageSid, NumMedia, MediaUrl0, ...
 *
 * @param {object} params  parsed form body
 * @returns {object} { chatId, text, user, source, raw }
 */
function parseInboundWebhook(params) {
  const from = params.From || '';
  return {
    chatId: from, // we route per-sender — chat id = sender's whatsapp:+N
    text: params.Body || '',
    user: { id: from, name: params.ProfileName || from },
    source: 'whatsapp',
    media: Number(params.NumMedia || 0) > 0 ? params.MediaUrl0 : null,
    raw: params,
  };
}

/**
 * Build a Twilio TwiML response so the user gets an immediate reply
 * in their WhatsApp app. Even if we plan to do longer async work via
 * the AI loop, a 200 OK with empty <Response> tells Twilio the
 * webhook succeeded.
 */
function buildTwimlResponse(text) {
  if (!text) return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
  // Escape XML special chars
  const esc = String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${esc}</Message></Response>`;
}

module.exports = {
  sendMessage,
  verifyWebhookSignature,
  parseInboundWebhook,
  buildTwimlResponse,
};
