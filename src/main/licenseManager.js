'use strict';
/**
 * Horizon License Manager
 * ======================
 *
 * Gates access to the app behind a 15-day free trial + paid subscription.
 *
 *   Trial flow:
 *     First run   → trial starts, 15 days of unrestricted access.
 *     Trial active→ app works normally.
 *     Trial ended → app shows block screen; user must have active Pro.
 *
 *   Pro flow:
 *     User signs up on horizonaai.dev, pays via NOWPayments (crypto).
 *     Backend records active subscription with expiry date.
 *     Desktop polls /api/license/status every hour + on startup.
 *     If active, app unlocks. If lapsed, block screen again.
 *
 *   Security posture (be honest):
 *     - This is SERVER-SIDE verification (not HMAC-in-code).
 *       No key secret leaks into the public repo.
 *     - A determined reverse-engineer can still patch the binary to
 *       bypass the check. For a $9.99/mo Electron product, this is the
 *       industry-standard posture (Cursor, Raycast, Linear all work
 *       the same way).
 *     - Critical logic cannot be moved server-side because the agent
 *       runs locally. If we need stronger protection later, move Pro
 *       features into closed-source .hzplugin bundles served by the
 *       marketplace (issue a follow-up for that).
 *
 *   Offline grace:
 *     - License status is cached for 72h. Net failures don't boot
 *       paying users offline.
 *     - First-ever run requires no network (trial starts locally).
 *
 *   Fields stored (in horizon-settings, plain electron-store):
 *     lic.trialStart         ISO date, set on first run, never overwritten
 *     lic.cachedStatus       last server response ({ active, plan, expires_at })
 *     lic.cachedStatusAt     ISO date of last successful fetch
 *     lic.lastCheckAt        ISO date of last attempt (success or fail)
 */

const TRIAL_DAYS          = 15;
const OFFLINE_GRACE_HOURS = 72;
const POLL_INTERVAL_MS    = 60 * 60 * 1000;  // 1 hour

const K_TRIAL_START    = 'lic.trialStart';
const K_CACHED_STATUS  = 'lic.cachedStatus';
const K_CACHED_AT      = 'lic.cachedStatusAt';
const K_LAST_CHECK     = 'lic.lastCheckAt';

class LicenseManager {
  constructor({ settingsStore, marketplaceClient, logger }) {
    this.settings  = settingsStore;
    this.market    = marketplaceClient;
    this.log       = logger || (() => {});
    this.listeners = new Set();
    this._pollTimer = null;
    this._lastState = null;

    // Ensure trial is initialized on construction (idempotent).
    if (!this.settings.get(K_TRIAL_START)) {
      this.settings.set(K_TRIAL_START, new Date().toISOString());
      this.log('[license] trial initialized');
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Returns the effective access state.
   * {
   *   allowed:   boolean    — app may run
   *   reason:    string     — 'trial' | 'pro' | 'trial-expired' | 'expired' | 'unknown'
   *   trialDaysLeft: number — days remaining in trial (0 if past)
   *   plan:      string|null
   *   expiresAt: string|null (ISO)
   *   offline:   boolean    — using cached status because network failed
   * }
   */
  evaluate() {
    const now = Date.now();

    // Server-known state first (authoritative if fresh).
    const cached = this.settings.get(K_CACHED_STATUS);
    const cachedAt = this.settings.get(K_CACHED_AT);
    const cachedFresh = cachedAt && (now - Date.parse(cachedAt) < OFFLINE_GRACE_HOURS * 3600e3);

    if (cached && cachedFresh && cached.active) {
      return {
        allowed: true,
        reason: 'pro',
        trialDaysLeft: 0,
        plan: cached.plan || 'pro',
        expiresAt: cached.expires_at || null,
        offline: false,
      };
    }

    // Trial state (local-only; starts on first run).
    const ts = this.settings.get(K_TRIAL_START);
    const trialEnd = new Date(ts);
    trialEnd.setDate(trialEnd.getDate() + TRIAL_DAYS);
    const trialDaysLeft = Math.max(0, Math.ceil((trialEnd.getTime() - now) / 86400e3));

    if (trialDaysLeft > 0) {
      return {
        allowed: true,
        reason: 'trial',
        trialDaysLeft,
        plan: null,
        expiresAt: null,
        offline: !cachedFresh,
      };
    }

    // Cached says inactive, or never fetched, and trial is over → block.
    return {
      allowed: false,
      reason: cached ? 'expired' : 'trial-expired',
      trialDaysLeft: 0,
      plan: cached?.plan || null,
      expiresAt: cached?.expires_at || null,
      offline: !cachedFresh,
    };
  }

  /**
   * Calls the server for fresh license state. Updates cache on success.
   * Returns the latest evaluate() after the call (so caller can react).
   */
  async refresh() {
    this.settings.set(K_LAST_CHECK, new Date().toISOString());
    try {
      // Only poll if the user is logged in — otherwise trial-only logic applies.
      if (!this.market.token) {
        this.log('[license] no token — skipping server poll');
        return this._emit(this.evaluate());
      }
      const status = await this.market.licenseStatus();  // added in marketplaceApi.js
      this.settings.set(K_CACHED_STATUS, status);
      this.settings.set(K_CACHED_AT, new Date().toISOString());
      this.log('[license] server status:', status);
    } catch (e) {
      this.log('[license] server poll failed:', e.message);
      // Keep old cache — offline grace handles it.
    }
    return this._emit(this.evaluate());
  }

  /**
   * Start background polling. Call once from main after app is ready.
   */
  startPolling() {
    this.stopPolling();
    // First check is fast (2s) so the UI can react right after login.
    setTimeout(() => this.refresh(), 2000);
    this._pollTimer = setInterval(() => this.refresh(), POLL_INTERVAL_MS);
  }

  stopPolling() {
    if (this._pollTimer) clearInterval(this._pollTimer);
    this._pollTimer = null;
  }

  /**
   * Subscribe to state changes. Listener receives the evaluate() payload.
   * Returns an unsubscribe function.
   */
  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Clear all license-related state (used on logout).
   */
  clearCache() {
    this.settings.delete(K_CACHED_STATUS);
    this.settings.delete(K_CACHED_AT);
    this.settings.delete(K_LAST_CHECK);
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  _emit(state) {
    // Only notify when something substantive changed.
    const key = JSON.stringify([state.allowed, state.reason, state.plan, state.expiresAt, state.trialDaysLeft]);
    if (key === this._lastState) return state;
    this._lastState = key;
    for (const fn of this.listeners) {
      try { fn(state); } catch (e) { this.log('[license] listener error:', e.message); }
    }
    return state;
  }
}

module.exports = { LicenseManager, TRIAL_DAYS };
