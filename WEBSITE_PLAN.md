# Horizon Website — `horizonaai.dev`

Plan for the Next.js 14 web frontend inside
`ErnestKostevich/HorizonWebMarketplace/web/`.

> **Deploy target:** Cloudflare Pages (free, includes DDoS + CDN).
> **Stack:** Next.js 14 (App Router) + TypeScript + Tailwind + shadcn/ui.
> **Auth:** NextAuth.js with credentials provider against the backend (OAuth to be added later).
> **Form protection:** Cloudflare Turnstile (free, GDPR-friendly CAPTCHA).

---

## 1. Route map

```
/                                   ← landing (hero, features, screenshots, Download CTA)
/download                           ← per-platform artifact links (from GitHub Releases)
/pricing                            ← $9.99/mo vs $99/yr, payment FAQ, what's included
/pro/thanks                         ← success after NOWPayments pay
/pro/cancelled                      ← cancel / fallback
/docs                               ← MDX articles
/docs/[...slug]                     ← doc pages
/blog                               ← (optional, phase 2, SEO)
/blog/[slug]

/marketplace                        ← browse + filter plugins
/marketplace/[plugin_id]            ← plugin detail page + Buy button
/marketplace/category/[category]
/marketplace/creator/[creator_id]   ← public creator profile

/creators                           ← landing for creators (why build, how to)
/creators/publish                   ← docs for plugin authors

/login                              ← email + password (Turnstile gate)
/signup                             ← same
/logout                             ← clears session
/verify-email                       ← email verification link target
/forgot-password

/dashboard                          ← user home (subscription state, owned plugins)
/dashboard/subscription             ← Pro plan status, upgrade/cancel, billing history
/dashboard/settings                 ← name, email, password change
/dashboard/creator                  ← creator home (earnings, recent sales, plugin list)
/dashboard/creator/new              ← upload new plugin
/dashboard/creator/plugins/[id]     ← edit plugin (drafts + rejected show edit, others read-only)
/dashboard/creator/payout           ← request payout, payout history

/dashboard/admin                    ← ERNEST ONLY — gated by role: admin
/dashboard/admin/plugins            ← queue of plugins pending review
/dashboard/admin/plugins/[id]       ← review diff + approve/reject
/dashboard/admin/payouts            ← pending payout requests + CSV export

/horizon-auth                       ← deep-link landing. After login on web,
                                      redirects to horizon://auth?token=...
                                      so the desktop app catches it.
```

---

## 2. Design language (match desktop)

Same Apple Vision × Linear × Fractal Core direction as the desktop pages
(`progate.html`, `setup.html`):

- **Background:** Julia-set fragment shader, slow breathing, amber/cyan palette.
- **Glass cards:** `backdrop-filter: blur(28px) saturate(140%)`, subtle gradient borders.
- **Typography:** Inter (UI) + JetBrains Mono (code / invoice IDs / hashes).
- **Accent palette:**
  ```css
  --amber-0: #ffb566;
  --amber-1: #e8a050;
  --cyan-0:  #7ee6ff;
  --cyan-1:  #5bd5f5;
  --bg-0:    #07080b;
  --bg-1:    #0a0c10;
  --text-0:  rgba(255,255,255,0.92);
  --text-1:  rgba(255,255,255,0.62);
  ```
- **Animation:** hover = gentle glow + 1px lift. No bouncing. Easing `cubic-bezier(0.22, 1, 0.36, 1)`.

Create a shared `components/FractalBackground.tsx` that mirrors
`scripts/fractal-bg.js` in the desktop (same shader, same colors) so
users moving from web → desktop feel continuity.

---

## 3. Landing page content structure

```
HERO
  ┌─────────────────────────────────────────────────────┐
  │ Your AI agent. On your desktop. Your keys.          │
  │                                                     │
  │ Horizon Genesis is a cross-platform AI assistant    │
  │ that runs on your machine, uses your API keys, and  │
  │ automates your workflows — not ours.                │
  │                                                     │
  │ [Download for Windows ▼] [See how it works]         │
  └─────────────────────────────────────────────────────┘

FEATURES GRID (3×2)
  - Real computer use (click, type, screenshot, shell)
  - Your keys, your spend (BYOK: OpenAI, Anthropic, etc)
  - 15 days free, $9.99/mo after
  - Cross-platform (Win / Mac / Linux)
  - Plugin marketplace
  - Open source preview on GitHub

SHOWCASE (video or animated GIF)

PRICING PREVIEW
  $9.99 / month   ← most popular
  $99 / year      ← save 17%
  [See pricing →]

MARKETPLACE TEASE
  "200+ community plugins, $1-$50 each."
  [Browse marketplace →]

FOOTER
  Links, contact, socials.
```

---

## 4. Critical components

### `<FractalBackground />`
Client component. Renders a WebGL canvas with the Julia shader. Fixed
position, z-index -1. Pauses when tab is hidden.

### `<GlassCard />`
Variants: `default`, `elevated`, `subtle`. Consistent padding + radius.

### `<TurnstileForm />`
Wraps a form, shows Turnstile widget, verifies token server-side before
submit proceeds. Used on /signup, /login, /forgot-password, /creators/publish.

### `<PricingCard />`
Monthly / Yearly toggle. Shows price + feature list + CTA. CTA opens
NOWPayments flow via backend.

### `<LicenseStatePill />`
In the user dashboard header. Shows "Pro — renews 2026-05-21" or "Trial
— 4 days left" or "Expired" with the right color.

### `<PluginCard />`
For the marketplace grid. Icon, name, creator, price, downloads.

### `<AdminGate />`
Wraps admin routes. Checks `session.user.role === 'admin'`, otherwise
redirects to 404.

---

## 5. Auth flow (email + password + Turnstile)

**Signup:**
1. User fills form (name, email, password) + Turnstile challenge.
2. Client POSTs to `/api/auth/signup-proxy` (Next.js route handler).
3. Handler verifies Turnstile token server-side.
4. Handler forwards credentials to `api.horizonaai.dev/api/auth/signup`.
5. Backend creates user, sends verification email via Resend.
6. User gets JWT back, stored in HTTP-only cookie (via NextAuth).

**Desktop login bridge:**
1. Desktop app opens `https://horizonaai.dev/login?return=horizon://auth`.
2. User logs in on the website.
3. On success, web app redirects to `horizon://auth?token=<jwt>`.
4. Desktop `main.js` already has a handler for the `horizon://` protocol —
   it catches the token, stores it in `settingsStore`, triggers
   `licenseManager.refresh()`.

---

## 6. Turnstile setup

Free tier: unlimited requests.

1. Cloudflare dashboard → Turnstile → Add site.
2. Domain: `horizonaai.dev`.
3. Widget mode: **Managed** (invisible until challenged).
4. Get `site-key` (public, goes in `NEXT_PUBLIC_TURNSTILE_SITE_KEY`) and
   `secret-key` (server-only, goes in `TURNSTILE_SECRET`).

Server-side verification snippet:
```ts
async function verifyTurnstile(token: string, ip: string) {
  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      secret: process.env.TURNSTILE_SECRET,
      response: token,
      remoteip: ip,
    }),
  });
  const j = await r.json();
  return j.success === true;
}
```

---

## 7. Rate limiting (backend side)

`slowapi` in FastAPI:
- `/api/auth/login` — 5 / min per IP
- `/api/auth/signup` — 10 / hour per IP
- `/api/auth/forgot-password` — 3 / hour per IP
- `/api/license/checkout/crypto` — 10 / hour per user
- `/api/plugins/*/purchase` — 20 / hour per user
- Everything else — 120 / min per user

Return `429` on violation. Client shows a toast "too many requests".

---

## 8. DDoS protection (free)

Cloudflare does this automatically when the domain is proxied through
Cloudflare. Settings to flip on the CF dashboard:

- **SSL/TLS:** Full (strict).
- **Always Use HTTPS:** ON.
- **Security Level:** Medium.
- **Bot Fight Mode:** ON (free tier).
- **Under Attack Mode:** OFF by default. Flip ON if you see an attack.

**Page Rule for webhook route:**
- URL: `api.horizonaai.dev/api/webhooks/*`
- Settings: Disable Performance, Disable Security. (NOWPayments must
  reach the raw server for HMAC verification to work on the exact bytes.)

---

## 9. Phase 2 (deferred — you said OAuth is overkill right now)

When you are ready to add Google / Microsoft / GitHub login:
- NextAuth.js has drop-in providers for all three.
- Google: Google Cloud Console → OAuth 2.0 Client ID → add
  `horizonaai.dev/api/auth/callback/google` to redirect URIs.
- Microsoft: Azure Portal → App Registration → add
  `horizonaai.dev/api/auth/callback/azure-ad`.
- GitHub: github.com/settings/developers → New OAuth app →
  `horizonaai.dev/api/auth/callback/github`.

All three providers are free. ~20 minutes of setup each.

---

## 10. Admin panel (`/dashboard/admin`)

Seed Ernest's user record with `role: "admin"` directly in Mongo:

```js
db.users.updateOne(
  { email: "ernest2011kostevich@gmail.com" },
  { $set: { role: "admin" } }
)
```

Middleware `middleware.ts`:
```ts
export async function middleware(req: NextRequest) {
  if (req.nextUrl.pathname.startsWith("/dashboard/admin")) {
    const session = await getToken({ req });
    if (session?.role !== "admin") {
      return NextResponse.rewrite(new URL("/404", req.url));
    }
  }
}
export const config = { matcher: "/dashboard/admin/:path*" };
```

---

## 11. First tasks when you start on `HorizonWebMarketplace/web/`

1. `npx create-next-app@latest web --ts --tailwind --app --src-dir`
2. `npx shadcn@latest init` (pick Zinc color, default everything else)
3. Install shadcn components you need: `button card dialog form input label`
4. `npm install next-auth @auth/core jose`
5. Create `components/FractalBackground.tsx` (copy shader from desktop).
6. Build `/` (landing) and `/pricing` first — they are the SEO front door.
7. Build `/login` + `/signup` with Turnstile.
8. Build `/dashboard` + `/dashboard/subscription`.
9. Build `/marketplace` + `/marketplace/[id]`.
10. Build `/dashboard/creator/*` (creator flow).
11. Build `/dashboard/admin/*` (moderation).

Estimated effort solo: 2–3 weekends for the core (items 1–8), 1 weekend
each for creator + admin flows. Total ~5 weekends.
