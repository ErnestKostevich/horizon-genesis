'use strict';
/**
 * Email channel adapter — IMAP inbound + SMTP outbound (PHASE 28.3).
 *
 * Like Hermes's email channel: lets the agent answer mail directly.
 * BYOK config — Horizon never sees the user's password. Both `imapflow`
 * and `nodemailer` are loaded lazily so the package doesn't gain weight
 * for users who don't run the email channel.
 *
 * Settings (all required when enabled):
 *   email.enabled        — bool, master switch
 *   email.imap.host      — e.g. "imap.gmail.com"
 *   email.imap.port      — default 993
 *   email.imap.user      — full email address
 *   email.imap.pass      — app-specific password (Gmail, Yahoo, etc.)
 *   email.imap.tls       — bool, default true
 *   email.imap.mailbox   — default "INBOX"
 *   email.imap.pollSec   — poll interval in seconds, default 60
 *   email.smtp.host      — e.g. "smtp.gmail.com"
 *   email.smtp.port      — default 587
 *   email.smtp.user      — defaults to imap.user
 *   email.smtp.pass      — defaults to imap.pass
 *   email.smtp.from      — "Name <email>" default uses smtp.user
 *
 * Inbound flow:
 *   - Poll INBOX every pollSec seconds.
 *   - Fetch UNSEEN messages.
 *   - For each: emit `email:incoming` event with {from, subject, text,
 *     messageId}; the caller (connectionsManager) decides how to route
 *     it into the agent (typically `runAgentLoop({task: text})`).
 *   - Mark message as seen after we've handled it.
 *
 * Outbound flow:
 *   - `send({to, subject, body, inReplyTo?})` builds a MIME message,
 *     sends via nodemailer, returns {ok, messageId} or {ok:false, err}.
 *   - The agent gets a `email_send` tool that calls this.
 *
 * Failure modes:
 *   - Missing deps → adapter returns clear error from start().
 *   - Bad credentials → IMAP login fails fast, surfaced to user.
 *   - Per-message handler throws → logged, not fatal; next poll retries.
 */

const EventEmitter = require('events');

class EmailAdapter extends EventEmitter {
  constructor({ settingsStore, keysStore } = {}) {
    super();
    this.settingsStore = settingsStore;
    this.keysStore = keysStore;
    this.imap = null;
    this.transporter = null;
    this.pollTimer = null;
    this.running = false;
    this.lastError = '';
    this.lastErrorAt = null;
    this.lastPollAt = null;
    this.seenIds = new Set(); // in-memory dedupe across polls
  }

  isEnabled() {
    return !!(this.settingsStore?.get?.('email.enabled'));
  }

  status() {
    return {
      running: this.running,
      enabled: this.isEnabled(),
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
    };
  }

  _cfg() {
    const s = this.settingsStore;
    if (!s) return null;
    const imapHost = s.get('email.imap.host');
    const smtpHost = s.get('email.smtp.host');
    if (!imapHost && !smtpHost) return null;
    const imapUser = s.get('email.imap.user');
    const imapPass = s.get('email.imap.pass');
    return {
      imap: imapHost ? {
        host: imapHost,
        port: Number(s.get('email.imap.port')) || 993,
        secure: s.get('email.imap.tls') !== false,
        auth: { user: imapUser, pass: imapPass },
        mailbox: s.get('email.imap.mailbox') || 'INBOX',
        pollSec: Math.max(15, Number(s.get('email.imap.pollSec')) || 60),
      } : null,
      smtp: smtpHost ? {
        host: smtpHost,
        port: Number(s.get('email.smtp.port')) || 587,
        secure: (Number(s.get('email.smtp.port')) || 587) === 465,
        auth: {
          user: s.get('email.smtp.user') || imapUser,
          pass: s.get('email.smtp.pass') || imapPass,
        },
        from: s.get('email.smtp.from') || (s.get('email.smtp.user') || imapUser),
      } : null,
    };
  }

  async start() {
    if (this.running) return { ok: true, alreadyRunning: true };
    if (!this.isEnabled()) return { ok: false, error: 'email channel disabled in settings' };
    const cfg = this._cfg();
    if (!cfg) return { ok: false, error: 'email config missing (settings: email.imap.host / email.smtp.host)' };

    // Lazy-require so users without the channel don't pay the cost.
    let ImapFlow, nodemailer;
    try { ({ ImapFlow } = require('imapflow')); }
    catch (e) { return { ok: false, error: 'imapflow not installed — run `npm i imapflow` to enable inbound mail' }; }
    try { nodemailer = require('nodemailer'); }
    catch (e) { return { ok: false, error: 'nodemailer not installed — run `npm i nodemailer` to enable outbound mail' }; }

    // SMTP setup (used for sending replies).
    if (cfg.smtp) {
      try {
        this.transporter = nodemailer.createTransport({
          host: cfg.smtp.host,
          port: cfg.smtp.port,
          secure: cfg.smtp.secure,
          auth: cfg.smtp.auth,
        });
      } catch (e) {
        this.lastError = 'SMTP setup failed: ' + e.message;
        this.lastErrorAt = new Date().toISOString();
      }
    }

    // IMAP poll loop.
    if (cfg.imap) {
      this.imap = new ImapFlow({
        host: cfg.imap.host,
        port: cfg.imap.port,
        secure: cfg.imap.secure,
        auth: cfg.imap.auth,
        logger: false,
      });
      try {
        await this.imap.connect();
      } catch (e) {
        this.lastError = 'IMAP connect failed: ' + e.message;
        this.lastErrorAt = new Date().toISOString();
        return { ok: false, error: this.lastError };
      }
      const tick = async () => {
        if (!this.running) return;
        await this._pollOnce(cfg.imap.mailbox).catch(e => {
          this.lastError = 'poll error: ' + e.message;
          this.lastErrorAt = new Date().toISOString();
        });
        this.pollTimer = setTimeout(tick, cfg.imap.pollSec * 1000);
      };
      this.running = true;
      tick();
    } else {
      this.running = true; // SMTP-only mode (send replies, no inbound)
    }

    return { ok: true, imap: !!cfg.imap, smtp: !!cfg.smtp };
  }

  async stop() {
    this.running = false;
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
    if (this.imap) { try { await this.imap.logout(); } catch (_) {} this.imap = null; }
    if (this.transporter) { try { this.transporter.close?.(); } catch (_) {} this.transporter = null; }
    return { ok: true };
  }

  async _pollOnce(mailbox) {
    if (!this.imap) return;
    this.lastPollAt = new Date().toISOString();
    const lock = await this.imap.getMailboxLock(mailbox);
    try {
      // Fetch unseen messages, mark them as seen after we emit. Cap to
      // the most recent 50 so a flooded inbox doesn't lock the loop.
      const seqs = await this.imap.search({ seen: false }, { uid: true });
      const subset = (seqs || []).slice(-50);
      for (const uid of subset) {
        if (this.seenIds.has(uid)) continue;
        try {
          const msg = await this.imap.fetchOne(uid, { source: true, envelope: true, uid: true }, { uid: true });
          if (!msg) continue;
          // Parse using built-in source — keep it simple. For full
          // parsing the user can add `mailparser` later.
          const envelope = msg.envelope || {};
          const from = envelope.from?.[0] ? `${envelope.from[0].name || ''} <${envelope.from[0].address}>`.trim() : 'unknown';
          const subject = envelope.subject || '(no subject)';
          const messageId = envelope.messageId || `uid:${uid}`;
          const raw = msg.source ? msg.source.toString('utf8') : '';
          // Crude body extraction — first text/plain block.
          const bodyMatch = raw.match(/Content-Type: text\/plain[\s\S]*?\r\n\r\n([\s\S]*?)(?:\r\n--|\r\n\.\r\n|$)/i);
          const text = bodyMatch ? bodyMatch[1].trim().slice(0, 4000) : raw.split(/\r\n\r\n/)[1]?.slice(0, 4000) || '';
          this.seenIds.add(uid);
          this.emit('incoming', { from, subject, text, messageId, uid });
          try { await this.imap.messageFlagsAdd(uid, ['\\Seen'], { uid: true }); } catch (_) {}
        } catch (e) {
          console.warn('[email] message parse failed:', e.message);
        }
      }
    } finally {
      lock.release();
    }
  }

  async send({ to, subject, body, inReplyTo } = {}) {
    if (!this.transporter) return { ok: false, error: 'SMTP not configured' };
    const cfg = this._cfg();
    const from = cfg?.smtp?.from;
    if (!to || !subject) return { ok: false, error: 'to + subject required' };
    try {
      const info = await this.transporter.sendMail({
        from,
        to,
        subject,
        text: body || '',
        ...(inReplyTo ? { inReplyTo, references: [inReplyTo] } : {}),
      });
      return { ok: true, messageId: info.messageId };
    } catch (e) {
      this.lastError = 'send failed: ' + e.message;
      this.lastErrorAt = new Date().toISOString();
      return { ok: false, error: this.lastError };
    }
  }
}

module.exports = { EmailAdapter };
