// iMessage adapter via osascript (macOS-only).
//
// Apple doesn't provide an API for iMessage. The widely-used hack is
// to drive Messages.app via AppleScript through `osascript`. This
// works only on macOS, only when Messages.app is signed in to the
// user's iCloud account, and only for the keyboard-app's perspective
// (we can't see receipts or delivery status from the script side).
//
// Setup user-side:
//   1. Sign in to Messages.app with your Apple ID.
//   2. Grant Terminal (or your CLI host) "Accessibility" + "Automation"
//      permissions: System Settings → Privacy & Security → Automation
//      → enable your terminal to control "Messages".
//   3. `horizon connect imessage`   (no flags — just registers the
//      adapter as available)
//
// Capabilities (mac-only):
//   - send text to a buddy ID (phone or email tied to iCloud)
//   - send to an existing group chat by chat ID (chatXXXX)
// Out of scope: receiving messages (requires monitoring Messages SQLite
//               DB at ~/Library/Messages/chat.db which is complex and
//               sometimes blocked by privacy gates).

const { execFile } = require('node:child_process');

function isMacOS() { return process.platform === 'darwin'; }

/**
 * Send an iMessage. Returns within ~1s if Messages.app is responsive.
 *
 * @param {object} args
 * @param {string} args.to    "+1234567890" (SMS/iMessage buddy) or
 *                            "name@icloud.com" (iCloud buddy)
 * @param {string} args.text
 * @param {string} [args.service='iMessage']  service to use; can also be 'SMS'
 */
function sendMessage(args) {
  return new Promise((resolve) => {
    if (!isMacOS()) {
      return resolve({ ok: false, error: 'iMessage adapter requires macOS (Messages.app + AppleScript)' });
    }
    if (!args.to || !args.text) {
      return resolve({ ok: false, error: 'to + text required' });
    }
    const service = args.service || 'iMessage';
    // Escape text + buddy for AppleScript string literal
    const escText = String(args.text).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const escTo = String(args.to).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    const script = `
      tell application "Messages"
        set targetService to 1st account whose service type = ${service}
        set targetBuddy to participant "${escTo}" of targetService
        send "${escText}" to targetBuddy
      end tell
    `;

    execFile('osascript', ['-e', script], { timeout: 5000 }, (err, stdout, stderr) => {
      if (err) {
        return resolve({
          ok: false,
          error: 'osascript failed: ' + (err.message || 'unknown'),
          stderr: String(stderr || '').slice(0, 300),
          hint: 'Grant Terminal automation permission for Messages.app in System Settings → Privacy & Security.',
        });
      }
      resolve({ ok: true, to: args.to, service });
    });
  });
}

/**
 * Send to an existing chat (group or 1:1) by chat-id, which you can
 * look up in Messages.app database. More reliable than buddy resolution
 * for group chats with non-iMessage members.
 */
function sendToChat(args) {
  return new Promise((resolve) => {
    if (!isMacOS()) return resolve({ ok: false, error: 'macOS only' });
    if (!args.chatId || !args.text) return resolve({ ok: false, error: 'chatId + text required' });

    const escText = String(args.text).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const escChat = String(args.chatId).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    const script = `
      tell application "Messages"
        send "${escText}" to chat id "${escChat}"
      end tell
    `;

    execFile('osascript', ['-e', script], { timeout: 5000 }, (err, _stdout, stderr) => {
      if (err) {
        return resolve({
          ok: false,
          error: 'osascript failed: ' + (err.message || 'unknown'),
          stderr: String(stderr || '').slice(0, 300),
        });
      }
      resolve({ ok: true, chatId: args.chatId });
    });
  });
}

/**
 * Liveness check — does osascript exist + does Messages.app respond?
 */
function ping() {
  return new Promise((resolve) => {
    if (!isMacOS()) return resolve(false);
    execFile('osascript', ['-e', 'tell application "Messages" to return name'], { timeout: 2000 }, (err) => {
      resolve(!err);
    });
  });
}

/**
 * Pull recent messages from ~/Library/Messages/chat.db via the
 * preinstalled macOS sqlite3 CLI. The Messages SQLite schema:
 *   message.rowid          — monotonic; we track lastSeenRowid
 *   message.text           — body (can be NULL for attachments)
 *   message.attributedBody — RTF blob (we don't decode; fallback)
 *   message.is_from_me     — 0 = inbound, 1 = sent by us
 *   handle.id              — phone/email of the other party
 *   chat.guid              — group-chat identifier
 *
 * Two filtering rules:
 *   1. Only inbound messages (is_from_me = 0)
 *   2. rowid > lastSeenRowid we received last time
 *
 * Permissions: macOS requires the *Terminal* (or whatever shell parent
 * is running Horizon) to have Full Disk Access. Without it, chat.db
 * is inaccessible and sqlite3 errors with "unable to open database".
 *
 * @param {object} opts
 * @param {number} [opts.lastRowid]   only return rows with rowid > this
 * @param {number} [opts.limit=20]    cap rows returned
 * @returns {Promise<{ok, messages, latestRowid?, error?}>}
 */
function receiveMessages(opts = {}) {
  return new Promise((resolve) => {
    if (!isMacOS()) return resolve({ ok: false, messages: [], error: 'macOS only' });
    const lastRowid = Number(opts.lastRowid) || 0;
    const limit = Math.max(1, Math.min(100, Number(opts.limit) || 20));
    // chat.db lives at ~/Library/Messages/chat.db — sqlite3 expands ~
    // in -line scripts but spawning, we need an absolute path.
    const dbPath = require('node:path').join(require('node:os').homedir(), 'Library', 'Messages', 'chat.db');
    // Query: join message → handle → chat to get sender + group id.
    // Use unixepoch on date (Apple stores nanoseconds since 2001-01-01).
    const sql = `
      SELECT
        m.rowid AS rowid,
        COALESCE(m.text, '(attachment / non-text)') AS text,
        m.is_from_me AS is_from_me,
        m.date AS apple_date,
        h.id AS handle,
        c.guid AS chat_guid,
        c.display_name AS chat_name
      FROM message m
      LEFT JOIN handle h ON h.rowid = m.handle_id
      LEFT JOIN chat_message_join cmj ON cmj.message_id = m.rowid
      LEFT JOIN chat c ON c.rowid = cmj.chat_id
      WHERE m.is_from_me = 0
        AND m.rowid > ${lastRowid}
      ORDER BY m.rowid ASC
      LIMIT ${limit};
    `;
    execFile('sqlite3', [
      '-readonly',
      '-json',
      dbPath,
      sql,
    ], { timeout: 8000 }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || err.message || '');
        if (/unable to open|authorization denied|permission denied/i.test(msg)) {
          return resolve({
            ok: false, messages: [],
            error: 'Cannot read chat.db — grant Terminal (or your shell host) Full Disk Access in System Settings → Privacy & Security → Full Disk Access.',
          });
        }
        return resolve({ ok: false, messages: [], error: msg.slice(0, 200) });
      }
      let rows;
      try { rows = stdout.trim() ? JSON.parse(stdout) : []; }
      catch (e) { return resolve({ ok: false, messages: [], error: 'sqlite output not JSON: ' + e.message }); }
      const messages = rows.map(r => ({
        chatId: r.chat_guid || r.handle,
        text: r.text || '',
        user: { id: r.handle || 'unknown', name: r.chat_name || r.handle || 'iMessage' },
        source: 'imessage',
        groupId: r.chat_guid && r.chat_guid.startsWith('iMessage;-;chat') ? r.chat_guid : null,
        rowid: r.rowid,
        appleDate: r.apple_date,
      }));
      const latestRowid = messages.length ? messages[messages.length - 1].rowid : lastRowid;
      resolve({ ok: true, messages, latestRowid });
    });
  });
}

module.exports = { sendMessage, sendToChat, ping, isMacOS, receiveMessages };
