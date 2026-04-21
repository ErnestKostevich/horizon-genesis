# Horizon Backend Spec — Pro / License Endpoints

This document is the **contract** between the Horizon desktop app and the
marketplace backend at `https://api.horizonaai.dev` (FastAPI on Render).

The desktop code in `src/main/licenseManager.js` and
`src/main/marketplaceApi.js` already calls these endpoints. The backend
must expose them exactly as specified — shape, status codes, and error
semantics all matter.

> **Owner:** Ernest Kostevich
> **Payment processor:** NOWPayments (crypto only)
> **Data store:** MongoDB
> **Auth:** Bearer token in `Authorization` header (issued by existing
> `/api/auth/login` / `/api/auth/signup`)
> **Base URL:** `https://api.horizonaai.dev`

---

## 0. Prerequisites (existing endpoints — DO NOT CHANGE)

These are already live and the desktop relies on them. Included here so
the new endpoints can reuse the same auth model.

### `POST /api/auth/signup`
Body: `{ email, password, display_name }`
Response: `{ token, user: { id, email, display_name, ... } }`

### `POST /api/auth/login`
Body: `{ email, password }`
Response: `{ token, user: { id, email, display_name, ... } }`

### `GET /api/auth/me`
Header: `Authorization: Bearer <token>`
Response: `{ id, email, display_name, ... }`

All new endpoints below require `Authorization: Bearer <token>` **unless
stated otherwise** (the NOWPayments webhook is the only unauthenticated
one — it uses HMAC signature verification instead).

---

## 1. `GET /api/license/status`

Returns the caller's current subscription state. Called by the desktop:

- On app startup (via `licenseManager.refresh()`)
- Every 1 hour while the app is running (`POLL_INTERVAL_MS`)
- After the user clicks "I've paid — recheck" on the upgrade screen

### Request
```
GET /api/license/status
Authorization: Bearer <user_token>
```

### Response 200
```json
{
  "active": true,
  "plan": "monthly",
  "expires_at": "2026-05-21T18:00:00Z",
  "payment_pending": false,
  "last_payment_at": "2026-04-21T18:02:11Z"
}
```

### Field semantics
| Field | Type | Meaning |
|---|---|---|
| `active` | `bool` | `true` if the user currently has paid access. |
| `plan` | `"monthly"` \| `"yearly"` \| `null` | Current plan, or `null` if never paid. |
| `expires_at` | ISO 8601 string \| `null` | When current period ends. `null` if no subscription. |
| `payment_pending` | `bool` | `true` if an invoice is `waiting`/`confirming` (shows "checking payment…" in UI). |
| `last_payment_at` | ISO 8601 string \| `null` | Timestamp of most recent **finished** payment. |

### Response 401
User token invalid / expired.
```json
{ "detail": "Not authenticated" }
```

### Notes
- `active = true` **iff** `expires_at` is in the future AND the latest
  invoice for the user is in state `finished` (or `confirmed` if you
  want to be generous — pick one and stick to it).
- Do **not** return the user's invoice history here. Keep the payload
  small and cacheable.

---

## 2. `POST /api/license/checkout/crypto`

Creates a NOWPayments crypto invoice for the selected plan. The desktop
opens `pay_url` in the user's default browser and starts polling
`/api/license/invoice/{id}`.

### Request
```
POST /api/license/checkout/crypto
Authorization: Bearer <user_token>
Content-Type: application/json

{ "plan": "monthly" }
```

`plan` must be `"monthly"` or `"yearly"`. Anything else → 422.

### Response 200
```json
{
  "invoice_id": "np_abc123",
  "pay_url": "https://nowpayments.io/payment/?iid=abc123",
  "amount": 9.99,
  "currency": "USD",
  "plan": "monthly",
  "expires_at": "2026-04-21T19:00:00Z"
}
```

| Field | Type | Meaning |
|---|---|---|
| `invoice_id` | string | NOWPayments invoice ID. Store it on the user record so the webhook can find them later. |
| `pay_url` | URL | NOWPayments-hosted checkout page (user picks BTC / ETH / USDT / etc). |
| `amount` | number | USD amount. `9.99` for monthly, `99.00` for yearly. |
| `currency` | string | Always `"USD"` (the fiat denomination — NOWPayments converts on their side). |
| `plan` | string | Echo of the requested plan. |
| `expires_at` | ISO 8601 | When this invoice expires (NOWPayments default: ~1h). |

### Response 422
Invalid plan.
```json
{ "detail": "Invalid plan" }
```

### Implementation (FastAPI sketch)

```python
import os, httpx
from datetime import datetime, timedelta

NOWPAYMENTS_API_KEY = os.environ["NOWPAYMENTS_API_KEY"]
NOWPAYMENTS_BASE    = "https://api.nowpayments.io/v1"

PRICES = {
    "monthly": 9.99,
    "yearly":  99.00,
}

@app.post("/api/license/checkout/crypto")
async def create_crypto_checkout(
    body: CheckoutBody,
    user: User = Depends(get_current_user),
):
    if body.plan not in PRICES:
        raise HTTPException(422, "Invalid plan")

    price = PRICES[body.plan]
    order_id = f"hz_{user.id}_{int(datetime.utcnow().timestamp())}"

    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.post(
            f"{NOWPAYMENTS_BASE}/invoice",
            headers={"x-api-key": NOWPAYMENTS_API_KEY},
            json={
                "price_amount":   price,
                "price_currency": "usd",
                "order_id":       order_id,
                "order_description": f"Horizon Pro — {body.plan}",
                "ipn_callback_url": "https://api.horizonaai.dev/api/webhooks/nowpayments",
                "success_url": "https://horizonaai.dev/pro/thanks",
                "cancel_url":  "https://horizonaai.dev/pro/cancelled",
            },
        )
        r.raise_for_status()
        inv = r.json()

    # Persist the pending invoice so the webhook can credit the user.
    await db.invoices.insert_one({
        "_id":          inv["id"],
        "user_id":      user.id,
        "plan":         body.plan,
        "amount":       price,
        "currency":     "USD",
        "order_id":     order_id,
        "status":       "waiting",
        "created_at":   datetime.utcnow(),
        "pay_url":      inv["invoice_url"],
    })

    return {
        "invoice_id": inv["id"],
        "pay_url":    inv["invoice_url"],
        "amount":     price,
        "currency":   "USD",
        "plan":       body.plan,
        "expires_at": (datetime.utcnow() + timedelta(hours=1)).isoformat() + "Z",
    }
```

---

## 3. `GET /api/license/invoice/{invoice_id}`

Poll endpoint. The desktop calls this every 8 seconds after the user
clicks "Pay with crypto", stopping when status is a terminal value.

### Request
```
GET /api/license/invoice/np_abc123
Authorization: Bearer <user_token>
```

### Response 200
```json
{ "status": "waiting" }
```

### `status` values

| Value | Terminal? | Meaning |
|---|---|---|
| `waiting` | no | Invoice created, no payment received yet. |
| `confirming` | no | Payment on-chain, waiting for confirmations. |
| `confirmed` | yes* | Enough confirmations, funds received. Credit the user. |
| `finished` | yes | NOWPayments has fully finalized the invoice. |
| `failed` | yes | Payment failed (wrong amount, chain error, etc). |
| `expired` | yes | Invoice window closed without payment. |

*The desktop treats both `confirmed` and `finished` as success.

### Response 404
Invoice does not belong to this user (or does not exist).
```json
{ "detail": "Invoice not found" }
```

### Implementation notes
- Only return invoices owned by the authenticated user. Reject otherwise.
- You can either (a) read `status` straight from your `invoices`
  collection (which the webhook keeps up-to-date) or (b) proxy-query
  NOWPayments. Prefer (a) — it's faster and survives NOWPayments hiccups.

---

## 4. `POST /api/webhooks/nowpayments`  *(unauthenticated)*

Called by NOWPayments when an invoice changes state. This is the
**only** way a subscription becomes active. No auth header; signature
verification via HMAC instead.

### Headers
```
x-nowpayments-sig: <hmac_sha512_signature>
Content-Type: application/json
```

### Body (NOWPayments shape)
```json
{
  "payment_id":        123456789,
  "payment_status":    "finished",
  "pay_address":       "bc1q...",
  "price_amount":      9.99,
  "price_currency":    "usd",
  "pay_amount":        0.000234,
  "actually_paid":     0.000234,
  "pay_currency":      "btc",
  "order_id":          "hz_<user_id>_<timestamp>",
  "order_description": "Horizon Pro — monthly",
  "invoice_id":        "abc123",
  "purchase_id":       "5678",
  "outcome_amount":    9.99,
  "outcome_currency":  "usdt"
}
```

### Signature verification

NOWPayments signs the **sorted-JSON** serialization of the body with
your IPN secret (HMAC-SHA-512, hex-encoded).

```python
import hmac, hashlib, json, os

IPN_SECRET = os.environ["NOWPAYMENTS_IPN_SECRET"].encode()

@app.post("/api/webhooks/nowpayments")
async def nowpayments_webhook(
    request: Request,
    x_nowpayments_sig: str = Header(...),
):
    raw = await request.body()
    payload = json.loads(raw)

    # Verify: sort keys, re-serialize, HMAC-SHA512, compare hex.
    sorted_payload = json.dumps(payload, separators=(",", ":"), sort_keys=True)
    expected = hmac.new(
        IPN_SECRET, sorted_payload.encode(), hashlib.sha512
    ).hexdigest()

    if not hmac.compare_digest(expected, x_nowpayments_sig):
        raise HTTPException(401, "Invalid signature")

    await handle_payment_update(payload)
    return {"ok": True}
```

### State transitions

```python
async def handle_payment_update(p: dict):
    invoice_id = str(p["invoice_id"])
    status     = p["payment_status"]   # waiting | confirming | confirmed | finished | failed | expired
    order_id   = p.get("order_id", "")

    # Parse order_id: "hz_<user_id>_<ts>"
    parts = order_id.split("_")
    if len(parts) < 3 or parts[0] != "hz":
        return
    user_id = parts[1]

    # Update the invoice record.
    await db.invoices.update_one(
        {"_id": invoice_id},
        {"$set": {
            "status":        status,
            "updated_at":    datetime.utcnow(),
            "actually_paid": p.get("actually_paid"),
            "pay_currency":  p.get("pay_currency"),
        }},
    )

    # Only extend the subscription on terminal success.
    if status not in ("confirmed", "finished"):
        return

    invoice = await db.invoices.find_one({"_id": invoice_id})
    if not invoice:
        return
    if invoice.get("credited"):
        return  # idempotency — already applied

    plan = invoice["plan"]
    delta = timedelta(days=365 if plan == "yearly" else 30)

    # Extend existing subscription OR start a new one.
    sub = await db.subscriptions.find_one({"user_id": user_id})
    now = datetime.utcnow()
    if sub and sub.get("expires_at") and sub["expires_at"] > now:
        new_expiry = sub["expires_at"] + delta
    else:
        new_expiry = now + delta

    await db.subscriptions.update_one(
        {"user_id": user_id},
        {"$set": {
            "user_id":         user_id,
            "plan":            plan,
            "expires_at":      new_expiry,
            "last_payment_at": now,
            "last_invoice_id": invoice_id,
        }},
        upsert=True,
    )

    await db.invoices.update_one(
        {"_id": invoice_id},
        {"$set": {"credited": True, "credited_at": now}},
    )
```

### Response 200
```json
{ "ok": true }
```

NOWPayments retries on non-2xx. Always return 200 after a successful
signature verification, even for status values you don't care about.

---

## 5. MongoDB collections

### `users` *(already exists)*
Whatever you already have. The license system only needs a stable `_id`.

### `subscriptions`
One document per user. Presence of this document does not imply active —
check `expires_at > now`.

```json
{
  "_id":             ObjectId,
  "user_id":         "user_123",
  "plan":            "monthly",            // "monthly" | "yearly"
  "expires_at":      ISODate("2026-05-21T18:00:00Z"),
  "last_payment_at": ISODate("2026-04-21T18:02:11Z"),
  "last_invoice_id": "abc123"
}
```

Index:
```js
db.subscriptions.createIndex({ user_id: 1 }, { unique: true })
```

### `invoices`
Append-only. One document per NOWPayments invoice ever created.

```json
{
  "_id":          "abc123",            // NOWPayments invoice id
  "user_id":      "user_123",
  "plan":         "monthly",
  "amount":       9.99,
  "currency":     "USD",
  "order_id":     "hz_user_123_1713718400",
  "status":       "finished",           // waiting|confirming|confirmed|finished|failed|expired
  "created_at":   ISODate,
  "updated_at":   ISODate,
  "actually_paid":0.000234,
  "pay_currency": "btc",
  "pay_url":      "https://nowpayments.io/payment/?iid=abc123",
  "credited":     true,
  "credited_at":  ISODate
}
```

Indexes:
```js
db.invoices.createIndex({ user_id: 1, created_at: -1 })
db.invoices.createIndex({ status: 1 })
```

---

## 6. Environment variables to set on Render

```
NOWPAYMENTS_API_KEY=<from nowpayments dashboard>
NOWPAYMENTS_IPN_SECRET=<from nowpayments dashboard>
MONGODB_URI=<already set>
JWT_SECRET=<already set>
HORIZON_WEB_URL=https://horizonaai.dev
HORIZON_API_URL=https://api.horizonaai.dev
```

---

## 7. Testing checklist

### Happy path
1. Sign up a test user in the desktop app → token saved.
2. Click **Pay with crypto** on the progate screen → `POST /checkout/crypto` returns `pay_url`, browser opens.
3. Pay the invoice via NOWPayments sandbox.
4. Webhook fires → subscription row created, `expires_at` = now + 30 days.
5. Desktop polls `GET /license/status` (every 8s during invoice; every 1h after) → returns `{active: true, plan: "monthly", ...}`.
6. App unlocks, progate screen replaced by chat.

### Edge cases to verify
- **Duplicate webhook**: call the webhook twice with the same payload → user's `expires_at` extends only once (idempotency via `invoice.credited` flag).
- **Expired invoice**: NOWPayments sends `payment_status: expired` → `invoice.status` updates, no subscription change.
- **Renewal**: user pays again while subscription is still active → `expires_at` extends from current expiry, not from `now`.
- **Logout mid-poll**: desktop calls `licenseState` with no token → `licenseManager` returns `reason: 'trial-expired'`, app shows progate.
- **Offline grace**: backend down for 24h → desktop uses last-known `active: true`, app still works. Beyond 72h → blocked.
- **Signature tampering**: modify one byte of the body → webhook returns 401, no subscription change.

### Local dev
- Use `ngrok http 8000` or Render's preview deploys so NOWPayments can reach your webhook endpoint.
- NOWPayments has a **sandbox** (https://sandbox.nowpayments.io). Use it until you trust the flow, then swap the keys.

---

## 8. Why this shape (design notes for future me)

- **Server-side truth, local cache**: client never decides if a user is
  Pro — only the server does. Cache exists only to survive network
  blips (72h grace). A reverse-engineer can still patch the binary to
  ignore the answer, but they cannot mint a valid subscription entry.
- **Webhook-driven activation**: the client never tells the server "I
  paid". NOWPayments → backend is the only path to `active: true`.
- **One user, one subscription row**: renewals mutate `expires_at`.
  Keeps the model simple and matches how we want to think about access.
- **Separate `invoices` history**: every payment is auditable. If a
  user disputes, we can see exactly what happened.
- **Order ID encodes user ID**: even if NOWPayments drops the
  `invoice_id → user` link, we can recover from `order_id`.
