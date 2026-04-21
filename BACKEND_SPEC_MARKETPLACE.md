# Horizon Backend Spec — Marketplace (Paid Plugins)

Extension to [`BACKEND_SPEC.md`](./BACKEND_SPEC.md). Covers the plugin
marketplace: community creators publish plugins, users buy them,
revenue splits 70/30 (creator/platform).

> **Phase:** implement after `BACKEND_SPEC.md` Pro subscription is live.
> **Dependencies:** MongoDB, NOWPayments (same account), existing auth.
> **Payout engine:** NOWPayments Mass Payouts (CSV upload or API).

---

## Business rules

| Rule | Value |
|---|---|
| Creator share | 70% of sale price |
| Platform share | 30% of sale price |
| Plugin pricing | Creator-set, USD, $1 – $200 range |
| Min payout | $25 |
| Payout cadence | Ernest triggers manually (weekly recommended) |
| Moderation | Pre-review on Phase 1 (all plugins reviewed by Ernest before going live). Auto-publish + takedown on Phase 2 (>20 plugins in catalog). |
| Plugin license | Lifetime per-user (no per-device seat limits). No refunds after install. |

---

## 1. `POST /api/plugins/{plugin_id}/purchase`

Buyer-facing. Creates a NOWPayments invoice for the plugin. Similar to
`/api/license/checkout/crypto` but the `order_id` encodes `plugin` so
the webhook knows what to credit.

### Request
```
POST /api/plugins/cool-plugin-slug/purchase
Authorization: Bearer <user_token>
```

### Response 200
```json
{
  "invoice_id": "np_xyz789",
  "pay_url":    "https://nowpayments.io/payment/?iid=xyz789",
  "amount":     10.00,
  "currency":   "USD",
  "plugin_id":  "cool-plugin-slug",
  "expires_at": "2026-04-21T19:00:00Z"
}
```

### Response 400 / 404
- `404` if plugin not found or `status != approved`.
- `400` if user already owns this plugin.

### Implementation sketch

```python
@app.post("/api/plugins/{plugin_id}/purchase")
async def purchase_plugin(
    plugin_id: str,
    user: User = Depends(get_current_user),
):
    plugin = await db.plugins.find_one({"_id": plugin_id, "status": "approved"})
    if not plugin:
        raise HTTPException(404, "Plugin not found")

    existing = await db.plugin_licenses.find_one({
        "user_id": user.id, "plugin_id": plugin_id
    })
    if existing:
        raise HTTPException(400, "Already owned")

    price = plugin["price_usd"]
    # Order ID encodes type so the webhook can route: hz_plg_<user>_<plugin>_<ts>
    order_id = f"hz_plg_{user.id}_{plugin_id}_{int(datetime.utcnow().timestamp())}"

    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.post(
            f"{NOWPAYMENTS_BASE}/invoice",
            headers={"x-api-key": NOWPAYMENTS_API_KEY},
            json={
                "price_amount":      price,
                "price_currency":    "usd",
                "order_id":          order_id,
                "order_description": f"Horizon plugin — {plugin['name']}",
                "ipn_callback_url":  "https://api.horizonaai.dev/api/webhooks/nowpayments",
                "success_url":       f"https://horizonaai.dev/marketplace/{plugin_id}?paid=1",
                "cancel_url":        f"https://horizonaai.dev/marketplace/{plugin_id}",
            },
        )
        r.raise_for_status()
        inv = r.json()

    await db.invoices.insert_one({
        "_id":        inv["id"],
        "type":       "plugin",
        "user_id":    user.id,
        "plugin_id":  plugin_id,
        "creator_id": plugin["creator_id"],
        "amount":     price,
        "currency":   "USD",
        "order_id":   order_id,
        "status":     "waiting",
        "created_at": datetime.utcnow(),
        "pay_url":    inv["invoice_url"],
    })

    return {
        "invoice_id": inv["id"],
        "pay_url":    inv["invoice_url"],
        "amount":     price,
        "currency":   "USD",
        "plugin_id":  plugin_id,
        "expires_at": (datetime.utcnow() + timedelta(hours=1)).isoformat() + "Z",
    }
```

---

## 2. `GET /api/plugins/{plugin_id}/license`

Desktop calls this at install time and at plugin load. If `{owned: false}`
the desktop refuses to install / load.

### Request
```
GET /api/plugins/cool-plugin-slug/license
Authorization: Bearer <user_token>
```

### Response 200
```json
{ "owned": true, "purchased_at": "2026-04-21T18:02:11Z", "invoice_id": "np_xyz789" }
```

or

```json
{ "owned": false }
```

Free plugins (`plugin.price_usd == 0`) → always `{ "owned": true }`.

---

## 3. `POST /api/plugins/publish`

Creator-facing. Upload a new plugin bundle for review.

### Request (multipart/form-data)
```
POST /api/plugins/publish
Authorization: Bearer <creator_token>
Content-Type: multipart/form-data

bundle:     <file: cool-plugin.hzplugin>
slug:       "cool-plugin-slug"
name:       "Cool Plugin"
description: "Does cool things."
price_usd:  10.00
category:   "automation"
```

### Response 201
```json
{
  "plugin_id": "cool-plugin-slug",
  "status":    "pending_review",
  "message":   "Submitted for review. Expect a response within 72 hours."
}
```

### Implementation notes
- Validate bundle (must be a valid `.hzplugin`, manifest parses, no
  code larger than 5 MB, no `require('child_process')` outside known-safe
  patterns). Run the same validator as the desktop `pluginManager.js`.
- Store bundle in object storage (Cloudflare R2 is free up to 10 GB).
  Key: `plugins/{plugin_id}/{version}/bundle.hzplugin`.
- Insert `plugins` doc with `status: "pending_review"`.
- Send Ernest an email via Resend: _"New plugin pending review: Cool Plugin by @creator"_.
- Ernest reviews in `dashboard/admin/plugins` (Next.js page — see `WEBSITE_PLAN.md`).

---

## 4. `POST /api/admin/plugins/{plugin_id}/moderate`

Ernest-only. Approves or rejects a pending plugin.

### Request
```
POST /api/admin/plugins/cool-plugin-slug/moderate
Authorization: Bearer <ernest_token>

{
  "action": "approve",
  "notes":  ""
}
```

`action`: `"approve"` | `"reject"`. `notes` is shown to the creator.

### Response 200
```json
{ "plugin_id": "cool-plugin-slug", "status": "approved" }
```

Check Ernest's user record has `role: "admin"` (seed this manually).

---

## 5. `GET /api/creators/me/earnings`

Creator dashboard data.

### Response 200
```json
{
  "balance_usd":            83.30,
  "lifetime_earned_usd":    420.00,
  "lifetime_paid_out_usd":  336.70,
  "pending_payout_request": null,
  "recent_sales": [
    { "plugin_id": "cool-plugin-slug", "plugin_name": "Cool Plugin",
      "amount": 7.00, "at": "2026-04-20T11:03:00Z" },
    { "plugin_id": "other-plugin",     "plugin_name": "Other Plugin",
      "amount": 14.00, "at": "2026-04-18T09:22:00Z" }
  ]
}
```

`balance_usd = lifetime_earned_usd - lifetime_paid_out_usd - pending_payout_amount`.
If `balance_usd < MIN_PAYOUT ($25)` the dashboard greys out the
"Request payout" button.

---

## 6. `POST /api/creators/me/payout-request`

Creator requests payout of current balance to a crypto address.

### Request
```
POST /api/creators/me/payout-request
Authorization: Bearer <creator_token>

{
  "currency": "USDTTRC20",
  "address":  "T..."
}
```

### Response 200
```json
{
  "payout_id":   "po_abc123",
  "amount_usd":  83.30,
  "currency":    "USDTTRC20",
  "address":     "T...",
  "status":      "queued",
  "requested_at":"2026-04-21T18:02:11Z"
}
```

### Response 400
```json
{ "detail": "Balance below minimum ($25.00)" }
```

### Implementation notes
- Freeze balance on request (`pending_payout_amount` column).
- Insert `pending_payouts` row. Ernest sees this in `dashboard/admin/payouts`.
- Creator can have only ONE pending payout at a time.

---

## 7. `POST /api/admin/payouts/batch`

Ernest-only. Downloads a CSV of all queued payouts in the format NOWPayments
Mass Payouts expects (you saw this screen: `account.nowpayments.io/mass-payouts`).

### Request
```
POST /api/admin/payouts/batch
Authorization: Bearer <ernest_token>
```

### Response 200
```
Content-Type: text/csv; charset=utf-8
Content-Disposition: attachment; filename=horizon-payouts-2026-04-21.csv

currency,address,amount,order_id
USDTTRC20,T...,83.30,po_abc123
USDTSOL,5y4B3s2jgw...,42.15,po_def456
```

Ernest uploads this CSV at `account.nowpayments.io/mass-payouts` → "Upload CSV file".

### After upload
NOWPayments sends IPN webhooks per payout line. Extend the webhook handler
(`BACKEND_SPEC.md` §4) to match on `order_id` starting with `po_` and
update the `creator_payouts` row:

```python
if order_id.startswith("po_"):
    await db.creator_payouts.update_one(
        {"_id": order_id},
        {"$set": {
            "status":     payload["payment_status"],
            "tx_hash":    payload.get("payout_hash"),
            "updated_at": datetime.utcnow(),
        }},
    )
    if payload["payment_status"] == "finished":
        await db.pending_payouts.delete_one({"_id": order_id})
    return
```

---

## 8. Webhook extension (shared with `BACKEND_SPEC.md` §4)

The existing NOWPayments webhook handler needs to route based on `order_id`
prefix:

```python
async def handle_payment_update(p: dict):
    order_id = p.get("order_id", "")
    if order_id.startswith("hz_sub_") or order_id.startswith("hz_"):
        # Subscription payment — existing logic
        return await handle_subscription_payment(p)
    if order_id.startswith("hz_plg_"):
        # Plugin purchase
        return await handle_plugin_purchase(p)
    if order_id.startswith("po_"):
        # Mass payout settlement
        return await handle_payout_settlement(p)
```

### `handle_plugin_purchase`

```python
async def handle_plugin_purchase(p: dict):
    invoice_id = str(p["invoice_id"])
    status     = p["payment_status"]

    await db.invoices.update_one(
        {"_id": invoice_id},
        {"$set": {"status": status, "updated_at": datetime.utcnow()}},
    )

    if status not in ("confirmed", "finished"):
        return

    inv = await db.invoices.find_one({"_id": invoice_id})
    if not inv or inv.get("credited"):
        return

    user_id    = inv["user_id"]
    plugin_id  = inv["plugin_id"]
    creator_id = inv["creator_id"]
    price      = inv["amount"]
    creator_share  = round(price * 0.70, 2)
    platform_share = round(price - creator_share, 2)

    # 1. Grant the buyer a plugin license.
    await db.plugin_licenses.insert_one({
        "user_id":       user_id,
        "plugin_id":     plugin_id,
        "purchased_at":  datetime.utcnow(),
        "invoice_id":    invoice_id,
    })

    # 2. Credit the creator.
    await db.creator_earnings.insert_one({
        "creator_id":     creator_id,
        "invoice_id":     invoice_id,
        "plugin_id":      plugin_id,
        "amount":         creator_share,
        "platform_fee":   platform_share,
        "sale_price":     price,
        "created_at":     datetime.utcnow(),
    })

    # 3. Update plugin stats.
    await db.plugins.update_one(
        {"_id": plugin_id},
        {"$inc": {"sales_count": 1, "total_revenue": price}},
    )

    # 4. Flag invoice credited (idempotency).
    await db.invoices.update_one(
        {"_id": invoice_id},
        {"$set": {"credited": True, "credited_at": datetime.utcnow()}},
    )
```

---

## 9. MongoDB collections (extend `BACKEND_SPEC.md` §5)

### `plugins`
```json
{
  "_id":            "cool-plugin-slug",
  "creator_id":     "user_123",
  "name":           "Cool Plugin",
  "description":    "Does cool things.",
  "category":       "automation",
  "price_usd":      10.00,
  "status":         "approved",
  "bundle_url":     "https://r2.horizonaai.dev/plugins/cool-plugin-slug/1.0.0/bundle.hzplugin",
  "version":        "1.0.0",
  "sales_count":    42,
  "total_revenue":  420.00,
  "submitted_at":   ISODate,
  "approved_at":    ISODate,
  "rejected_at":    null,
  "rejection_note": null
}
```
`status`: `"draft"` | `"pending_review"` | `"approved"` | `"rejected"` | `"takedown"`

Indexes:
```js
db.plugins.createIndex({ creator_id: 1 })
db.plugins.createIndex({ status: 1, approved_at: -1 })
db.plugins.createIndex({ category: 1 })
```

### `plugin_licenses`
```json
{
  "_id":          ObjectId,
  "user_id":      "user_123",
  "plugin_id":    "cool-plugin-slug",
  "purchased_at": ISODate,
  "invoice_id":   "np_xyz789"
}
```
Indexes:
```js
db.plugin_licenses.createIndex({ user_id: 1, plugin_id: 1 }, { unique: true })
db.plugin_licenses.createIndex({ plugin_id: 1 })
```

### `creator_earnings`
Append-only ledger. Never mutate. Source of truth for balance.
```json
{
  "_id":          ObjectId,
  "creator_id":   "user_123",
  "invoice_id":   "np_xyz789",
  "plugin_id":    "cool-plugin-slug",
  "amount":       7.00,
  "platform_fee": 3.00,
  "sale_price":   10.00,
  "created_at":   ISODate
}
```
Indexes:
```js
db.creator_earnings.createIndex({ creator_id: 1, created_at: -1 })
```

### `pending_payouts`
Current queue awaiting Ernest's batch.
```json
{
  "_id":          "po_abc123",
  "creator_id":   "user_123",
  "amount_usd":   83.30,
  "currency":     "USDTTRC20",
  "address":      "T...",
  "requested_at": ISODate,
  "status":       "queued"
}
```

### `creator_payouts`
Historical record.
```json
{
  "_id":         "po_abc123",
  "creator_id":  "user_123",
  "amount_usd":  83.30,
  "currency":    "USDTTRC20",
  "address":     "T...",
  "status":      "finished",
  "tx_hash":     "0xabc...",
  "requested_at":ISODate,
  "sent_at":     ISODate,
  "updated_at":  ISODate
}
```

---

## 10. Balance calculation

Computed, not stored:

```python
async def compute_balance(creator_id: str) -> float:
    earned = await db.creator_earnings.aggregate([
        {"$match": {"creator_id": creator_id}},
        {"$group": {"_id": None, "sum": {"$sum": "$amount"}}}
    ]).to_list(1)
    earned_sum = earned[0]["sum"] if earned else 0

    paid = await db.creator_payouts.aggregate([
        {"$match": {"creator_id": creator_id, "status": "finished"}},
        {"$group": {"_id": None, "sum": {"$sum": "$amount_usd"}}}
    ]).to_list(1)
    paid_sum = paid[0]["sum"] if paid else 0

    pending = await db.pending_payouts.aggregate([
        {"$match": {"creator_id": creator_id}},
        {"$group": {"_id": None, "sum": {"$sum": "$amount_usd"}}}
    ]).to_list(1)
    pending_sum = pending[0]["sum"] if pending else 0

    return round(earned_sum - paid_sum - pending_sum, 2)
```

---

## 11. Desktop integration points

These already exist in `src/main/marketplaceApi.js`:
- `list()`, `featured()`, `detail()`, `install()`, `bundle()`

Extend with:
```js
purchasePlugin(pluginId) {
  return this._fetch(`/api/plugins/${pluginId}/purchase`, { method: 'POST' });
}
pluginLicense(pluginId) {
  return this._fetch(`/api/plugins/${pluginId}/license`);
}
```

And in `pluginManager.js`, gate install:
```js
async installRemote(pluginId) {
  const lic = await marketClient.pluginLicense(pluginId);
  if (!lic.owned) throw new Error('PLUGIN_NOT_OWNED');
  const bundle = await marketClient.bundle(pluginId);
  // ... existing install logic
}
```

---

## 12. Pre-review process (Phase 1)

Until ~20 published plugins, Ernest reviews manually. Checklist:

- [ ] Bundle parses, manifest valid
- [ ] No obfuscated code beyond minification
- [ ] No `child_process`, `fs.unlinkSync` on system paths, no `fetch` to suspicious domains
- [ ] No attempts to read `keysStore` or `settingsStore` directly
- [ ] Stated functionality matches code
- [ ] Price is sane for what it does ($5 minimum; $50 suggested cap for Phase 1)

Rejection note is returned to creator in their dashboard.

After 20 approved plugins, flip the `PLUGIN_AUTO_PUBLISH` env var to `true` and
switch to passive moderation (takedown on report).

---

## 13. Testing checklist (delta from BACKEND_SPEC.md)

- [ ] Buyer purchases plugin → `plugin_licenses` row created, creator's `creator_earnings` +$7 on $10 sale.
- [ ] Duplicate webhook fires → second invocation is no-op (`invoice.credited: true` gate).
- [ ] Free plugin install → `GET /license` returns `{owned: true}` without touching invoices.
- [ ] Creator below $25 balance requests payout → 400.
- [ ] Creator at $27 requests payout → row in `pending_payouts`, balance drops to $2 in next `/earnings` call.
- [ ] Admin POSTs `/payouts/batch` → CSV downloads in NOWPayments format.
- [ ] Admin uploads CSV to NOWPayments, payout webhook fires with `finished` → `creator_payouts.status = "finished"`, `pending_payouts` row removed.
