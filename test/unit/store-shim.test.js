// Unit tests for src/main/runtime/store-shim.js — path resolution + encrypted store init.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { defaultUserDataDir, machineEncryptionKey, createStore, initStores } = require('../../src/main/runtime/store-shim');

test('defaultUserDataDir returns horizon-ai under platform-specific base', () => {
  const d = defaultUserDataDir();
  assert.match(d, /horizon-ai$/);
  if (process.platform === 'win32') assert.match(d, /AppData/i);
  if (process.platform === 'darwin') assert.match(d, /Library[\\\/]Application Support/);
});

test('machineEncryptionKey is deterministic + 32 hex chars', () => {
  const k1 = machineEncryptionKey();
  const k2 = machineEncryptionKey();
  assert.equal(k1, k2, 'must be deterministic on same machine');
  assert.equal(k1.length, 32);
  assert.match(k1, /^[0-9a-f]+$/);
});

test('createStore writes to user-supplied directory', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'horizon-store-test-'));
  const s = createStore({ userDataDir: tmp, name: 'horizon-test' });
  s.set('hello', 'world');
  assert.equal(s.get('hello'), 'world');
  assert.equal(s.path, path.join(tmp, 'horizon-test.json'));
  assert.ok(fs.existsSync(s.path));
});

test('createStore with encryption round-trips a value', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'horizon-store-test-'));
  const s = createStore({
    userDataDir: tmp,
    name: 'horizon-secret',
    encryptionKey: 'a'.repeat(32),
  });
  s.set('apiKey', 'sk-1234567890');
  // Re-read with a fresh instance to confirm decryption works
  const s2 = createStore({
    userDataDir: tmp,
    name: 'horizon-secret',
    encryptionKey: 'a'.repeat(32),
  });
  assert.equal(s2.get('apiKey'), 'sk-1234567890');
});

test('createStore requires name', () => {
  assert.throws(() => createStore({}));
});

test('initStores returns matched pair + dir', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'horizon-init-'));
  const { keysStore, settingsStore, userDataDir } = initStores({ userDataDir: tmp });
  assert.equal(userDataDir, tmp);
  assert.match(keysStore.path, /horizon-keys\.json$/);
  assert.match(settingsStore.path, /horizon-settings\.json$/);
});
