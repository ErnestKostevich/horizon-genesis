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

module.exports = { sendMessage, sendToChat, ping, isMacOS };
