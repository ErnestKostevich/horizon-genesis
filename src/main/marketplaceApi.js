'use strict';
/**
 * Horizon Marketplace API client (lives inside the Electron app).
 *
 * Talks to the Horizon Marketplace backend (the FastAPI service at
 * process.env.HORIZON_MARKETPLACE_URL or settingsStore.get('marketplaceUrl')).
 */

const DEFAULT_URL = 'https://api.horizonaai.dev';
const DEFAULT_WEB_URL = 'https://horizonaai.dev';

class MarketplaceClient {
  constructor(settingsStore) {
    this.settingsStore = settingsStore;
  }
  get base() {
    return (this.settingsStore && this.settingsStore.get('marketplaceUrl')) || process.env.HORIZON_MARKETPLACE_URL || DEFAULT_URL;
  }
  get webBase() {
    const explicit = (this.settingsStore && this.settingsStore.get('marketplaceWebUrl')) || process.env.HORIZON_MARKETPLACE_WEB_URL;
    if (explicit) return explicit.replace(/\/+$/, '');
    try {
      const u = new URL(this.base);
      if (u.hostname.startsWith('api.')) u.hostname = u.hostname.slice(4);
      return `${u.protocol}//${u.host}`.replace(/\/+$/, '');
    } catch {
      return DEFAULT_WEB_URL;
    }
  }
  get token() {
    return this.settingsStore && this.settingsStore.get('marketplaceToken');
  }
  async _fetch(path, opts = {}) {
    const fetch = (await import('node-fetch').then(m => m.default).catch(() => require('node-fetch')));
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const r = await fetch(this.base + path, { ...opts, headers });
    const text = await r.text();
    let j; try { j = JSON.parse(text); } catch { j = { raw: text }; }
    if (!r.ok) throw new Error(j.detail || j.raw || `${r.status} ${r.statusText}`);
    return j;
  }
  list({ q, category, tier, featured, sort = 'downloads', limit = 60 } = {}) {
    const qs = new URLSearchParams();
    if (q) qs.set('q', q);
    if (category) qs.set('category', category);
    if (tier) qs.set('tier', tier);
    if (featured) qs.set('featured', 'true');
    qs.set('sort', sort);
    qs.set('limit', String(limit));
    return this._fetch(`/api/plugins?${qs.toString()}`);
  }
  featured() { return this._fetch('/api/plugins/featured'); }
  detail(slugOrId) { return this._fetch(`/api/plugins/${encodeURIComponent(slugOrId)}`); }
  creator(id) { return this._fetch(`/api/creators/${encodeURIComponent(id)}`); }
  install(pluginId) { return this._fetch(`/api/plugins/${pluginId}/install`, { method: 'POST' }); }
  bundle(pluginId) { return this._fetch(`/api/plugins/${pluginId}/bundle`); }
  me() { return this._fetch('/api/auth/me'); }
  login(email, password) {
    return this._fetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })
      .then(d => {
        if (this.settingsStore) {
          this.settingsStore.set('marketplaceToken', d.token);
          this.settingsStore.set('marketplaceUser', d.user);
        }
        return d;
      });
  }
  signup(email, password, display_name) {
    return this._fetch('/api/auth/signup', { method: 'POST', body: JSON.stringify({ email, password, display_name }) })
      .then(d => {
        if (this.settingsStore) {
          this.settingsStore.set('marketplaceToken', d.token);
          this.settingsStore.set('marketplaceUser', d.user);
        }
        return d;
      });
  }
  logout() {
    if (this.settingsStore) {
      this.settingsStore.delete('marketplaceToken');
      this.settingsStore.delete('marketplaceUser');
    }
  }

  // ── License / Subscription ─────────────────────────────────────────────────
  // Server returns: { active: bool, plan: 'monthly'|'yearly'|null, expires_at: ISO|null,
  //                   payment_pending: bool, last_payment_at: ISO|null }
  licenseStatus() {
    return this._fetch('/api/license/status');
  }

  /**
   * Create a NOWPayments crypto invoice for the given plan.
   * Returns: { invoice_id, pay_url, amount, currency, plan, expires_at }
   * The desktop app opens pay_url in the user's default browser.
   */
  createCryptoPayment(plan /* 'monthly' | 'yearly' */) {
    return this._fetch('/api/license/checkout/crypto', {
      method: 'POST',
      body: JSON.stringify({ plan }),
    });
  }

  /**
   * Poll an invoice until paid. Used by the upgrade window to detect completion
   * without forcing the user back to the desktop app manually.
   * Returns: { status: 'waiting'|'confirming'|'confirmed'|'finished'|'failed'|'expired' }
   */
  pollInvoice(invoiceId) {
    return this._fetch(`/api/license/invoice/${encodeURIComponent(invoiceId)}`);
  }
}

module.exports = { MarketplaceClient };
