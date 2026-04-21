# Horizon Pro — Deployment Checklist

This is the step-by-step list Ernest runs through to take the Pro
monetization system from "code written" to "users can pay me and the
app unlocks for them".

Order matters — each step unblocks the next.

---

## Phase 1 — NOWPayments account

1. **Finish the NOWPayments signup** (you have payout wallets set up —
   USDT Solana + USDT TON — and a test invoice works; only `Scope of
   activity` field remains). Paste this into the scope field:

   > Subscription-based desktop AI assistant (SaaS) and associated plugin
   > marketplace. Primary product: Horizon Genesis Pro, a cross-platform
   > AI agent application, sold at $9.99/month or $99/year via crypto
   > subscription. Secondary revenue: community plugin marketplace with
   > 30% platform commission. Expected initial monthly volume: $500-$2,000.
   > Payments accepted in BTC, ETH, USDT, USDC and other major
   > cryptocurrencies.

2. **Grab the two secrets**
   - Dashboard → **Settings → API Keys** → copy `NOWPAYMENTS_API_KEY`
   - Dashboard → **Settings → Payments** (or IPN section) → copy
     `NOWPAYMENTS_IPN_SECRET` (generate one if empty).

3. **Configure the IPN callback URL**:
   ```
   https://api.horizonaai.dev/api/webhooks/nowpayments
   ```
   Settings → Payments → "Instant payment notifications" → save.

4. **Request Mass Payouts access** (needed for creator revenue share later).
   Mass Payouts is in the sidebar but may need manual activation. Email
   NOWPayments support:
   > Subject: Enable Mass Payouts for my account
   > Body: Please enable Mass Payouts and the Payouts API for account
   > `ernest2011kostevich`. Use case: weekly payouts to marketplace
   > plugin creators via CSV batch. Expected volume: 10-50 payouts/week,
   > $25-$500 each.

5. **Optional — use the sandbox first**
   - https://sandbox.nowpayments.io (separate account, fake crypto)
   - Use it to test the full flow before flipping to the live keys.

---

## Phase 2 — Backend (Render)

All details for endpoint shapes, webhook verification, and MongoDB
collections live in [`BACKEND_SPEC.md`](./BACKEND_SPEC.md) (Pro
subscription) and [`BACKEND_SPEC_MARKETPLACE.md`](./BACKEND_SPEC_MARKETPLACE.md)
(plugin marketplace). This phase is about **doing** what the spec describes.

### Step A — Pro subscription endpoints

1. **Add the four new endpoints** to your FastAPI service:
   - `GET /api/license/status`
   - `POST /api/license/checkout/crypto`
   - `GET /api/license/invoice/{id}`
   - `POST /api/webhooks/nowpayments`

2. **Add MongoDB collections** + indexes:
   ```js
   db.subscriptions.createIndex({ user_id: 1 }, { unique: true })
   db.invoices.createIndex({ user_id: 1, created_at: -1 })
   db.invoices.createIndex({ status: 1 })
   ```

3. **Set env vars on Render** (Service → Environment):
   ```
   NOWPAYMENTS_API_KEY=<from Phase 1 step 2>
   NOWPAYMENTS_IPN_SECRET=<from Phase 1 step 2>
   TURNSTILE_SECRET=<from Cloudflare Turnstile>
   R2_ACCESS_KEY=<from Cloudflare R2, for plugin bundles>
   R2_SECRET_KEY=<from Cloudflare R2>
   ```

4. **Deploy** (push to main or manual redeploy). Wait for green build.

5. **Smoke-test the public GET** (no auth needed — should 401):
   ```
   curl -i https://api.horizonaai.dev/api/license/status
   # expected: 401
   ```

6. **Smoke-test with a real user token**:
   ```
   curl -H "Authorization: Bearer <token>" \
        https://api.horizonaai.dev/api/license/status
   # expected: {"active": false, "plan": null, ...}
   ```

### Step B — Marketplace endpoints (add after Step A works)

1. **Add marketplace endpoints** from `BACKEND_SPEC_MARKETPLACE.md`:
   - `POST /api/plugins/{id}/purchase`
   - `GET /api/plugins/{id}/license`
   - `POST /api/plugins/publish`
   - `GET /api/creators/me/earnings`
   - `POST /api/creators/me/payout-request`
   - `POST /api/admin/plugins/{id}/moderate` (Ernest-only)
   - `POST /api/admin/payouts/batch` (Ernest-only, returns CSV)

2. **Extend the webhook** (`POST /api/webhooks/nowpayments`) to route on
   `order_id` prefix: `hz_sub_` → subscription, `hz_plg_` → plugin purchase,
   `po_` → payout settlement. Code in `BACKEND_SPEC_MARKETPLACE.md §8`.

3. **Add marketplace collections**:
   ```js
   db.plugins.createIndex({ creator_id: 1 })
   db.plugins.createIndex({ status: 1, approved_at: -1 })
   db.plugins.createIndex({ category: 1 })
   db.plugin_licenses.createIndex({ user_id: 1, plugin_id: 1 }, { unique: true })
   db.plugin_licenses.createIndex({ plugin_id: 1 })
   db.creator_earnings.createIndex({ creator_id: 1, created_at: -1 })
   ```

4. **Seed your admin user**:
   ```js
   db.users.updateOne(
     { email: "ernest2011kostevich@gmail.com" },
     { $set: { role: "admin" } }
   )
   ```

5. **Set up Cloudflare R2** (free up to 10 GB, for plugin bundles):
   - Dashboard → R2 → Create bucket `horizon-plugins`.
   - Settings → API Tokens → Create R2 API token → save access key + secret.
   - Custom domain (optional): `r2.horizonaai.dev` → CF proxied.

---

## Phase 3 — Desktop app (already wired, just verify)

The desktop code is committed and calls the endpoints above. You only
need to verify it picks them up:

1. **Local test** — run `npm start`. The app should:
   - Show setup on first run (trial badge at top: "15 days free").
   - After setup → open chat, no block.
   - After the trial is over (you can simulate: edit
     `lic.trialStart` in the settings store to 16 days ago) → app
     redirects to `progate.html` (the block screen).

2. **Test login flow on the block screen**:
   - Click **Sign in** → opens `https://horizonaai.dev/login?return=horizon://auth`
     in the browser.
   - Log in on the web site. The site redirects to `horizon://auth?token=...`.
   - Desktop catches the deep link, stores the token, calls
     `licenseRefresh()` → app unlocks.

3. **Test pay flow**:
   - Click **Pay with crypto**.
   - Browser opens NOWPayments hosted invoice.
   - Use sandbox BTC to pay it.
   - Watch the desktop — every 8s it polls `/api/license/invoice/{id}`.
   - Once `confirmed`/`finished`, it calls `licenseRefresh()` and the
     app unlocks.

---

## Phase 4 — Release the Pro build

1. **Commit and push** the current changes (the summary commit is
   already drafted — run `git commit` with the message I gave you).

2. **Tag and push a release**:
   ```
   git tag v1.1.0
   git push origin v1.1.0
   ```

3. **GitHub Actions builds** all four platforms:
   - Windows `.exe` (NSIS)
   - macOS `.dmg` (Intel + Apple Silicon)
   - Linux `.AppImage` and `.deb`

4. **Verify the release page** has all six artifacts.

5. **Test the installed artifact end-to-end** on at least Windows and
   one Mac. The installed binary MUST show `official: true` in
   `build-info.json` (inside the asar) — this is what gates the
   source-preview banner.

---

## Phase 5 — User flow / support

When a user runs out of trial and contacts you instead of paying
through NOWPayments (common for non-crypto users):

1. They message you on Telegram (`@Ernest_Kostevich` or `@ernest0kostevich`)
   or email (`ernest2011kostevich@gmail.com` or `ernestkostevich@gmail.com`).
2. You agree on method (bank transfer, PayPal family-and-friends, Revolut, etc).
3. They pay you.
4. You manually extend their subscription in Mongo:
   ```js
   db.subscriptions.updateOne(
     { user_id: "<their id>" },
     { $set: {
         plan: "monthly",
         expires_at: new Date(Date.now() + 30*24*3600*1000),
         last_payment_at: new Date(),
         last_invoice_id: "manual-<yyyymmdd>"
     }},
     { upsert: true }
   )
   ```
5. On the user's next `/api/license/status` poll (≤1h), the app unlocks.

This is a **deliberate** fallback — it keeps the "only I can issue
access" property, satisfies the security requirement, and gives
non-crypto users a path.

---

## Phase 6 — Ongoing operations

- **Watch NOWPayments dashboard** for pending invoices — they can
  stall if a user pays the wrong amount.
- **Monthly: reconcile** by running:
  ```js
  db.subscriptions.find({ expires_at: { $lt: new Date() } }).count()
  ```
  to see lapsed users. Don't email them unsolicited; just make sure
  the block screen kicks in on their next launch (it will).
- **Backup Mongo weekly** — Render does this but make your own dump
  too. Subscriptions + invoices = your revenue history.

---

## Phase 7 — Marketplace operations (after Step B)

### Moderating new plugins (weekly)

1. Check `/dashboard/admin/plugins` for `status: "pending_review"` entries.
2. For each:
   - Download `bundle_url`, unzip, read `manifest.json` + `main.js`.
   - Verify checklist in `BACKEND_SPEC_MARKETPLACE.md §12`.
   - Click **Approve** or **Reject** with notes.
3. Approved plugins appear in `/marketplace` within 1 minute.

### Running creator payouts (weekly)

1. Go to `/dashboard/admin/payouts` — see queue of `pending_payouts`.
2. Click **Export CSV** → downloads NOWPayments-format file.
3. Open `account.nowpayments.io/mass-payouts` → **Upload CSV file**.
4. Confirm, NOWPayments processes, IPN webhooks update each row.
5. Within 1 hour all rows flip to `finished` or surface errors.

### Kill-switch for a bad plugin

```js
// Hide a plugin from the marketplace + block new installs.
// Existing owners keep access (don't break things they paid for).
db.plugins.updateOne(
  { _id: "bad-plugin-id" },
  { $set: { status: "takedown", takedown_reason: "...", takedown_at: new Date() } }
)
```

### Refund a plugin purchase (manual, rare)

```js
// 1. Revoke the buyer's license.
db.plugin_licenses.deleteOne({ user_id: "...", plugin_id: "..." })
// 2. Reverse the earning.
db.creator_earnings.insertOne({
  creator_id: "...",
  invoice_id: "REFUND_<yyyymmdd>",
  plugin_id:  "...",
  amount:     -7.00,                      // negative = reversal
  platform_fee: -3.00,
  sale_price: -10.00,
  created_at: new Date()
})
// 3. Refund the buyer off-chain (crypto, your choice of method).
```

---

## Taxes

You (Ernest) handle your own taxes per your Italian residency. Keep
the `invoices`, `creator_earnings`, and `creator_payouts` collections
as your source of truth — every entry has amount, currency, user, and
timestamp, which is what a tax advisor will ask for.

---

## Contacts

If NOWPayments, Render, or any of this breaks and you need to
disable Pro temporarily:

**Kill-switch**: set `expires_at` to far future on all existing
subscriptions in one query, and the app will keep unlocking. But the
cleaner fix is always to investigate.

```js
// EMERGENCY ONLY — grants everyone 7 days of free Pro
db.subscriptions.updateMany(
  {},
  { $set: { expires_at: new Date(Date.now() + 7*24*3600*1000) } }
)
```

Good luck. This shipped.
