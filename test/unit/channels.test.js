// Unit tests for channel adapter pure-functions (no network).

const test = require('node:test');
const assert = require('node:assert/strict');

const whatsapp = require('../../src/main/channels/whatsapp');
const signal = require('../../src/main/channels/signal');
const imessage = require('../../src/main/channels/imessage');

// ── WhatsApp ──────────────────────────────────────────────────────────
test('whatsapp.sendMessage refuses without config', async () => {
  const r = await whatsapp.sendMessage({}, { to: '+1', text: 'hi' });
  assert.equal(r.ok, false);
  assert.match(r.error, /WhatsApp not configured/);
});

test('whatsapp.sendMessage refuses without to+text', async () => {
  const r = await whatsapp.sendMessage(
    { accountSid: 'AC1', authToken: 'x', from: 'whatsapp:+1' },
    { to: '+1' }
  );
  assert.equal(r.ok, false);
});

test('whatsapp.verifyWebhookSignature accepts a correctly-signed payload', () => {
  const crypto = require('node:crypto');
  const authToken = 'test-token';
  const url = 'https://example.com/webhook';
  const params = { From: 'whatsapp:+1', Body: 'hello', MessageSid: 'SM1' };
  const sorted = Object.keys(params).sort();
  let data = url;
  for (const k of sorted) data += k + params[k];
  const signature = crypto.createHmac('sha1', authToken).update(data).digest('base64');
  const ok = whatsapp.verifyWebhookSignature({ authToken, url, params, signature });
  assert.equal(ok, true);
});

test('whatsapp.verifyWebhookSignature rejects bad signature', () => {
  const ok = whatsapp.verifyWebhookSignature({
    authToken: 'test-token',
    url: 'https://example.com/webhook',
    params: { Body: 'hi' },
    signature: 'definitely-wrong',
  });
  assert.equal(ok, false);
});

test('whatsapp.parseInboundWebhook builds normalised event', () => {
  const e = whatsapp.parseInboundWebhook({
    From: 'whatsapp:+12345',
    Body: 'hello horizon',
    MessageSid: 'SM-test',
    ProfileName: 'Test User',
    NumMedia: '0',
  });
  assert.equal(e.chatId, 'whatsapp:+12345');
  assert.equal(e.text, 'hello horizon');
  assert.equal(e.user.name, 'Test User');
  assert.equal(e.source, 'whatsapp');
  assert.equal(e.media, null);
});

test('whatsapp.buildTwimlResponse escapes XML special chars', () => {
  const xml = whatsapp.buildTwimlResponse('Hello <world> & "friends"');
  assert.match(xml, /&lt;world&gt;/);
  assert.match(xml, /&amp;/);
  assert.match(xml, /&quot;friends&quot;/);
  assert.match(xml, /<Response>/);
});

test('whatsapp.buildTwimlResponse handles empty body', () => {
  const xml = whatsapp.buildTwimlResponse('');
  assert.match(xml, /<Response><\/Response>/);
});

// ── Signal ─────────────────────────────────────────────────────────────
test('signal.sendMessage refuses without config', async () => {
  const r = await signal.sendMessage({}, { to: '+1', text: 'hi' });
  assert.equal(r.ok, false);
  assert.match(r.error, /Signal not configured/);
});

test('signal.parseInboundMessage handles 1-to-1 message', () => {
  const e = signal.parseInboundMessage({
    envelope: {
      source: '+1234567890',
      sourceName: 'Alice',
      timestamp: 1700000000000,
      dataMessage: { message: 'hi', timestamp: 1700000000000 },
    },
  });
  assert.equal(e.text, 'hi');
  assert.equal(e.chatId, '+1234567890');
  assert.equal(e.user.name, 'Alice');
  assert.equal(e.source, 'signal');
  assert.equal(e.groupId, null);
});

test('signal.parseInboundMessage handles group message', () => {
  const e = signal.parseInboundMessage({
    envelope: {
      source: '+1234567890',
      sourceName: 'Alice',
      timestamp: 1700000000000,
      dataMessage: {
        message: 'group hi',
        timestamp: 1700000000000,
        groupInfo: { groupId: 'GROUP_BASE64_ID' },
      },
    },
  });
  assert.equal(e.chatId, 'GROUP_BASE64_ID');
  assert.equal(e.groupId, 'GROUP_BASE64_ID');
});

test('signal.parseInboundMessage rejects empty envelope', () => {
  assert.equal(signal.parseInboundMessage({}), null);
  assert.equal(signal.parseInboundMessage({ envelope: { source: '+1' } }), null);
});

// ── iMessage ──────────────────────────────────────────────────────────
test('imessage.isMacOS reflects current platform', () => {
  assert.equal(imessage.isMacOS(), process.platform === 'darwin');
});

test('imessage.sendMessage refuses without macOS', async () => {
  // This test only runs on non-macOS — on macOS we'd actually call osascript.
  if (process.platform === 'darwin') return; // skip
  const r = await imessage.sendMessage({ to: '+1', text: 'hi' });
  assert.equal(r.ok, false);
  assert.match(r.error, /macOS/);
});

test('imessage.sendMessage refuses without to+text', async () => {
  if (process.platform !== 'darwin') return; // only relevant on mac
  const r = await imessage.sendMessage({ to: '+1' }); // no text
  assert.equal(r.ok, false);
});
