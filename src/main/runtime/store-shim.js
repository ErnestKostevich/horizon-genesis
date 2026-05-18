// Non-Electron settings/keys store, file-compatible with the Electron app.
//
// The Electron app uses `electron-store`, which under the hood is `conf`
// (Sindre Sorhus) — same JSON schema, atomic-write, AES-256-GCM encryption
// when an `encryptionKey` is passed. We use `conf` directly here so the
// CLI/TUI process (which has no `electron.app` available) can read and
// write the same `%APPDATA%/horizon-ai/horizon-settings.json` and
// `horizon-keys.json` files the GUI uses.
//
// Path resolution matches Electron's `app.getPath('userData')` for the
// project name `horizon-ai`:
//   - Windows: %APPDATA%/horizon-ai
//   - macOS:   ~/Library/Application Support/horizon-ai
//   - Linux:   ~/.config/horizon-ai
//
// Encryption key matches main.js: sha256(hostname + platform + cpuModel)
// first 32 hex chars. Same key on the same machine → CLI decrypts what
// the GUI wrote, and vice-versa.

const os = require('os');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

let Conf;
try {
  // conf v10 (transitive dep via electron-store) exports default in CJS interop
  Conf = require('conf').default || require('conf');
} catch (e) {
  Conf = null;
}

function defaultUserDataDir() {
  // Mirror Electron's app.getPath('userData') for projectName 'horizon-ai'
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appdata, 'horizon-ai');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'horizon-ai');
  }
  // linux + others
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdg, 'horizon-ai');
}

function machineEncryptionKey() {
  // Exactly mirrors main.js so files written by the GUI decrypt here.
  // crypto.createHash('sha256').update(hostname + platform + cpuModel).digest('hex').slice(0, 32)
  const parts = os.hostname() + os.platform() + (os.cpus()[0]?.model || '');
  return crypto.createHash('sha256').update(parts).digest('hex').slice(0, 32);
}

/**
 * Create a conf-backed store at the given userData directory, using the
 * same filename + encryption settings as the Electron app's Store().
 *
 * @param {object} opts
 * @param {string} [opts.userDataDir] override the directory (defaults to
 *   the OS-conventional location matching Electron's app.getPath('userData'))
 * @param {string} opts.name 'horizon-keys' or 'horizon-settings' — anything
 *   you'd pass as `new Store({ name })` in the main process.
 * @param {string} [opts.encryptionKey] AES-256-GCM key; omit for plaintext.
 * @returns {Conf} a conf instance with .get/.set/.delete/.path/.store
 */
function createStore({ userDataDir, name, encryptionKey } = {}) {
  if (!Conf) {
    throw new Error('`conf` not available — install electron-store or conf');
  }
  if (!name || typeof name !== 'string') {
    throw new Error('createStore: `name` is required');
  }
  const cwd = userDataDir || defaultUserDataDir();
  try { fs.mkdirSync(cwd, { recursive: true }); } catch (_) {}
  // `cwd` overrides env-paths, so the file lands at <cwd>/<name>.json —
  // exactly where electron-store with the same `name` writes it. We pass
  // a projectName for Conf's internal use but it doesn't affect the path
  // when `cwd` is set.
  return new Conf({
    cwd,
    configName: name,
    projectName: 'horizon-ai',
    encryptionKey: encryptionKey || undefined,
    accessPropertiesByDotNotation: true,
    fileExtension: 'json',
    clearInvalidConfig: false,
  });
}

/**
 * One-stop init for the CLI runtime. Returns the same two stores main.js
 * builds (keysStore, settingsStore) plus the resolved userDataDir.
 */
function initStores({ userDataDir } = {}) {
  const dir = userDataDir || defaultUserDataDir();
  const encKey = machineEncryptionKey();
  const keysStore = createStore({
    userDataDir: dir,
    name: 'horizon-keys',
    encryptionKey: encKey,
  });
  const settingsStore = createStore({
    userDataDir: dir,
    name: 'horizon-settings',
  });
  return { keysStore, settingsStore, userDataDir: dir };
}

module.exports = {
  createStore,
  initStores,
  defaultUserDataDir,
  machineEncryptionKey,
};
