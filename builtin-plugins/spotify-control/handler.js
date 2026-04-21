'use strict';
/**
 * Spotify Control — official demo plugin for Horizon Genesis.
 *
 * Architecture:
 *   - Authorization Code + PKCE (correct flow for a desktop public client)
 *   - Loopback redirect (http://127.0.0.1:8765/callback)
 *   - NO client_secret anywhere — secrets never ship in desktop binaries
 *   - Tokens stored locally via Electron safeStorage + electron-store
 *   - Refresh is automatic (60s safety margin) using the SAME /api/token endpoint
 *
 * About "Basic auth" / Base64:
 *   Base64 is NOT a Spotify API — it's the encoding used to build an
 *   HTTP Basic auth header: Authorization: Basic base64(client_id:client_secret).
 *   That header is used ONLY by the Client Credentials flow and the
 *   confidential-client Authorization Code flow. PKCE (what we use) does
 *   NOT use it; we pass client_id as a form field and prove request
 *   authenticity with code_verifier instead.
 */

const crypto = require('crypto');
const http = require('http');
const { URL } = require('url');

// Electron-optional: in tests the plugin can run with process.env.SPOTIFY_CLIENT_ID
// and an in-memory token store.
let shell, safeStorage, Store;
try {
  ({ shell, safeStorage } = require('electron'));
  Store = require('electron-store');
} catch { /* non-Electron environment — tests */ }

const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'streaming',
].join(' ');

const REDIRECT_PORTS = [8765, 8766, 8767, 8768, 8769, 8770];
const REDIRECT_PATH = '/callback';
const TOKEN_ENDPOINT = 'https://accounts.spotify.com/api/token';
const AUTHORIZE_ENDPOINT = 'https://accounts.spotify.com/authorize';
const API_BASE = 'https://api.spotify.com/v1';

// ---------- Token storage ----------
const memStore = { enc: null };
const store = Store ? new Store({ name: 'spotify-tokens' }) : { get: (k) => memStore[k], set: (k, v) => { memStore[k] = v; }, delete: (k) => { delete memStore[k]; } };

function encrypt(obj) {
  const s = JSON.stringify(obj);
  if (safeStorage && safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(s).toString('base64');
  }
  // dev fallback: NOT for production, but keeps tests working
  return Buffer.from(s, 'utf8').toString('base64');
}
function decrypt(b64) {
  if (!b64) return null;
  try {
    if (safeStorage && safeStorage.isEncryptionAvailable()) {
      return JSON.parse(safeStorage.decryptString(Buffer.from(b64, 'base64')));
    }
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch { return null; }
}
function saveTokens(t) { store.set('enc', encrypt(t)); }
function loadTokens() { return decrypt(store.get('enc')); }
function wipeTokens() { store.delete('enc'); }

// ---------- PKCE helpers ----------
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function makeVerifier() {
  return b64url(crypto.randomBytes(32)); // 43 chars
}
function challengeFor(verifier) {
  return b64url(crypto.createHash('sha256').update(verifier).digest());
}

// ---------- Loopback OAuth server ----------
function startLoopback() {
  return new Promise(async (resolve, reject) => {
    for (const port of REDIRECT_PORTS) {
      const server = http.createServer();
      const taken = await new Promise((r) => {
        server.once('error', () => r(true));
        server.listen(port, '127.0.0.1', () => r(false));
      });
      if (taken) continue;
      resolve({
        port,
        redirectUri: `http://127.0.0.1:${port}${REDIRECT_PATH}`,
        waitForCode: (expectedState, timeoutMs = 180_000) => new Promise((ok, ko) => {
          const timer = setTimeout(() => { server.close(); ko(new Error('OAuth timeout')); }, timeoutMs);
          server.on('request', (req, res) => {
            const u = new URL(req.url, `http://127.0.0.1:${port}`);
            if (u.pathname !== REDIRECT_PATH) {
              res.statusCode = 404; res.end('not found'); return;
            }
            const code = u.searchParams.get('code');
            const state = u.searchParams.get('state');
            const err = u.searchParams.get('error');
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            if (err) {
              res.end(`<html><body style="font-family:monospace;background:#050505;color:#F9FAFB;padding:40px">Spotify error: ${err}. You can close this tab.</body></html>`);
              clearTimeout(timer); server.close(); ko(new Error('OAuth denied: ' + err)); return;
            }
            if (!code || state !== expectedState) {
              res.end('<html><body style="font-family:monospace;background:#050505;color:#F9FAFB;padding:40px">Invalid state. Close this tab and retry from Horizon.</body></html>');
              clearTimeout(timer); server.close(); ko(new Error('Invalid state')); return;
            }
            res.end('<html><body style="font-family:monospace;background:#050505;color:#F9FAFB;padding:40px">Connected. You can close this tab and return to Horizon.</body></html>');
            clearTimeout(timer); server.close(); ok(code);
          });
        }),
      });
      return;
    }
    reject(new Error(`No free port in range ${REDIRECT_PORTS.join(', ')}`));
  });
}

async function openBrowser(url) {
  if (shell && shell.openExternal) return shell.openExternal(url);
  // fallback for tests
  return null;
}

// ---------- Token exchange / refresh ----------
async function postTokenEndpoint(form) {
  const body = new URLSearchParams(form).toString();
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, // NO Basic auth header in PKCE
    body,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Token endpoint ${res.status}: ${j.error_description || j.error || 'unknown'}`);
  return j;
}

async function connect(clientId) {
  if (!clientId) throw new Error('Spotify Client ID is required (set it in plugin settings).');
  const verifier = makeVerifier();
  const challenge = challengeFor(verifier);
  const state = b64url(crypto.randomBytes(16));
  const { redirectUri, waitForCode } = await startLoopback();

  const authUrl = new URL(AUTHORIZE_ENDPOINT);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('scope', SCOPES);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  await openBrowser(authUrl.toString());
  const code = await waitForCode(state);

  const tok = await postTokenEndpoint({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  });

  const tokens = {
    client_id: clientId,
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_in: tok.expires_in,
    scope: tok.scope,
    obtained_at: Date.now(),
  };
  saveTokens(tokens);
  return tokens;
}

async function refresh(tokens) {
  const r = await postTokenEndpoint({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id: tokens.client_id,
  });
  const next = {
    ...tokens,
    access_token: r.access_token,
    expires_in: r.expires_in,
    obtained_at: Date.now(),
    // Spotify may rotate the refresh_token
    refresh_token: r.refresh_token || tokens.refresh_token,
    scope: r.scope || tokens.scope,
  };
  saveTokens(next);
  return next;
}

async function accessToken() {
  let t = loadTokens();
  if (!t) throw new Error('NOT_CONNECTED');
  if (Date.now() > t.obtained_at + (t.expires_in - 60) * 1000) {
    try { t = await refresh(t); }
    catch { wipeTokens(); throw new Error('REFRESH_FAILED — please reconnect.'); }
  }
  return t.access_token;
}

// ---------- Spotify API calls ----------
async function api(path, { method = 'GET', body } = {}) {
  const token = await accessToken();
  const res = await fetch(API_BASE + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return { ok: true };
  if (res.status === 401) { wipeTokens(); throw new Error('TOKEN_REJECTED — please reconnect.'); }
  if (res.status === 403) throw new Error('FORBIDDEN — Spotify Premium may be required.');
  if (res.status === 404) throw new Error('NO_ACTIVE_DEVICE — start playback somewhere or call list_devices.');
  if (res.status === 429) throw new Error('RATE_LIMITED — retry after ' + (res.headers.get('Retry-After') || '?') + 's');
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error?.message || `HTTP ${res.status}`);
  return j;
}

// ---------- Tool dispatcher ----------
module.exports = {
  async execute(tool, args = {}, ctx = {}) {
    const cfg = ctx.settings || {};
    const clientId = cfg.client_id || process.env.SPOTIFY_CLIENT_ID;

    try {
      switch (tool) {
        case 'connect': {
          const t = await connect(clientId);
          const me = await api('/me').catch(() => null);
          return { ok: true, out: `Connected as ${me?.display_name || '(unknown)'} · ${me?.product || 'free'}` };
        }
        case 'disconnect': {
          wipeTokens();
          return { ok: true, out: 'Disconnected. Tokens wiped.' };
        }
        case 'status': {
          const t = loadTokens();
          if (!t) return { ok: true, out: 'Disconnected' };
          const ttl = Math.max(0, Math.round((t.obtained_at + t.expires_in * 1000 - Date.now()) / 1000));
          return { ok: true, out: `Connected · token TTL ${ttl}s · client_id ${t.client_id.slice(0, 6)}…` };
        }
        case 'play':              await api('/me/player/play',  { method: 'PUT'  }); return { ok: true, out: '▶ playing' };
        case 'pause':             await api('/me/player/pause', { method: 'PUT'  }); return { ok: true, out: '⏸ paused' };
        case 'next':              await api('/me/player/next',  { method: 'POST' }); return { ok: true, out: '⏭ next' };
        case 'previous':          await api('/me/player/previous', { method: 'POST' }); return { ok: true, out: '⏮ previous' };
        case 'set_volume': {
          const p = Math.max(0, Math.min(100, parseInt(args.percent, 10) || 0));
          await api(`/me/player/volume?volume_percent=${p}`, { method: 'PUT' });
          return { ok: true, out: `volume ${p}%` };
        }
        case 'list_devices': {
          const d = await api('/me/player/devices');
          return { ok: true, out: (d.devices || []).map((x) => `${x.is_active ? '*' : ' '} ${x.name} [${x.type}] ${x.id}`).join('\n') || '(no devices)' };
        }
        case 'transfer_playback': {
          if (!args.device_id) throw new Error('device_id required');
          await api('/me/player', { method: 'PUT', body: { device_ids: [args.device_id], play: true } });
          return { ok: true, out: 'playback transferred' };
        }
        case 'current_track': {
          const t = await api('/me/player/currently-playing');
          if (!t || !t.item) return { ok: true, out: '(nothing playing)' };
          const artists = (t.item.artists || []).map((a) => a.name).join(', ');
          return { ok: true, out: `${t.item.name} — ${artists}` };
        }
        case 'search': {
          const r = await api(`/search?type=track&limit=10&q=${encodeURIComponent(args.query || '')}`);
          const items = (r.tracks && r.tracks.items) || [];
          return { ok: true, out: items.map((it, i) => `${i + 1}. ${it.name} — ${(it.artists || []).map((a) => a.name).join(', ')} [${it.uri}]`).join('\n') || '(no results)' };
        }
        default:
          return { ok: false, error: `Unknown tool: ${tool}` };
      }
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  },
};
