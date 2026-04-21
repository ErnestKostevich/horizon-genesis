'use strict';
/**
 * Horizon AI — Google OAuth for Gmail & Calendar
 * 
 * Uses Electron's BrowserWindow for OAuth2 flow.
 * No server needed — tokens stored locally.
 */

const { BrowserWindow } = require('electron');
const https = require('https');

// Google OAuth2 config
// Users must create their own OAuth app at console.cloud.google.com
// Or use Horizon's default client ID (limited quota)
const DEFAULT_CLIENT_ID = '';  // User provides their own
const DEFAULT_CLIENT_SECRET = '';
const REDIRECT_URI = 'http://localhost';
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events'
].join(' ');

class GoogleAuth {
  constructor(store) {
    this.store = store; // electron-store instance
  }

  /**
   * Start OAuth2 flow in a new window
   */
  async authenticate(clientId, clientSecret) {
    const cid = clientId || this.store.get('google_client_id') || DEFAULT_CLIENT_ID;
    const secret = clientSecret || this.store.get('google_client_secret') || DEFAULT_CLIENT_SECRET;
    
    if (!cid) {
      return { ok: false, error: 'Google Client ID not set. Go to Settings → Google OAuth' };
    }
    
    return new Promise((resolve) => {
      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
        `client_id=${encodeURIComponent(cid)}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
        `&response_type=code` +
        `&scope=${encodeURIComponent(SCOPES)}` +
        `&access_type=offline` +
        `&prompt=consent`;

      const authWin = new BrowserWindow({
        width: 600,
        height: 700,
        webPreferences: { nodeIntegration: false, contextIsolation: true }
      });

      authWin.loadURL(authUrl);

      // Listen for redirect with auth code
      authWin.webContents.on('will-redirect', async (event, url) => {
        const code = this._extractCode(url);
        if (code) {
          authWin.close();
          const tokens = await this._exchangeCode(code, cid, secret);
          if (tokens.ok) {
            this.store.set('google_access_token', tokens.access_token);
            this.store.set('google_refresh_token', tokens.refresh_token);
            this.store.set('google_token_expiry', Date.now() + (tokens.expires_in * 1000));
            this.store.set('google_client_id', cid);
            this.store.set('google_client_secret', secret);
          }
          resolve(tokens);
        }
      });

      authWin.webContents.on('will-navigate', async (event, url) => {
        const code = this._extractCode(url);
        if (code) {
          authWin.close();
          const tokens = await this._exchangeCode(code, cid, secret);
          if (tokens.ok) {
            this.store.set('google_access_token', tokens.access_token);
            this.store.set('google_refresh_token', tokens.refresh_token);
            this.store.set('google_token_expiry', Date.now() + (tokens.expires_in * 1000));
          }
          resolve(tokens);
        }
      });

      authWin.on('closed', () => {
        resolve({ ok: false, error: 'Auth window closed' });
      });
    });
  }

  _extractCode(url) {
    try {
      const u = new URL(url);
      return u.searchParams.get('code');
    } catch {
      return null;
    }
  }

  async _exchangeCode(code, clientId, clientSecret) {
    return new Promise((resolve) => {
      const data = new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code'
      }).toString();

      const req = https.request({
        hostname: 'oauth2.googleapis.com',
        path: '/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(data)
        }
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            if (parsed.access_token) {
              resolve({ ok: true, ...parsed });
            } else {
              resolve({ ok: false, error: parsed.error_description || 'Token exchange failed' });
            }
          } catch {
            resolve({ ok: false, error: 'Parse error' });
          }
        });
      });

      req.on('error', (e) => resolve({ ok: false, error: e.message }));
      req.write(data);
      req.end();
    });
  }

  /**
   * Get valid access token (auto-refresh if expired)
   */
  async getAccessToken() {
    const token = this.store.get('google_access_token');
    const expiry = this.store.get('google_token_expiry');
    const refresh = this.store.get('google_refresh_token');

    if (!token) return { ok: false, error: 'Not authenticated' };

    // Token still valid
    if (expiry && Date.now() < expiry - 60000) {
      return { ok: true, token };
    }

    // Need refresh
    if (!refresh) return { ok: false, error: 'Refresh token missing. Re-authenticate.' };

    const clientId = this.store.get('google_client_id');
    const clientSecret = this.store.get('google_client_secret');

    return new Promise((resolve) => {
      const data = new URLSearchParams({
        refresh_token: refresh,
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token'
      }).toString();

      const req = https.request({
        hostname: 'oauth2.googleapis.com',
        path: '/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(data)
        }
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            if (parsed.access_token) {
              this.store.set('google_access_token', parsed.access_token);
              this.store.set('google_token_expiry', Date.now() + (parsed.expires_in * 1000));
              resolve({ ok: true, token: parsed.access_token });
            } else {
              resolve({ ok: false, error: 'Refresh failed' });
            }
          } catch {
            resolve({ ok: false, error: 'Parse error' });
          }
        });
      });

      req.on('error', (e) => resolve({ ok: false, error: e.message }));
      req.write(data);
      req.end();
    });
  }

  /**
   * Check if authenticated
   */
  isAuthenticated() {
    return !!this.store.get('google_access_token');
  }

  /**
   * Logout
   */
  logout() {
    this.store.delete('google_access_token');
    this.store.delete('google_refresh_token');
    this.store.delete('google_token_expiry');
    return { ok: true };
  }
}

module.exports = { GoogleAuth };
