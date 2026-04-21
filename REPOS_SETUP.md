# Horizon — Repository Map

This doc maps every piece of the project to a concrete GitHub repository,
says what goes in each, and gives the first-steps command list.

---

## The four repos

| Repo | Visibility | Exists? | Purpose |
|---|---|---|---|
| `ErnestKostevich/horizon-genesis` | **public** | ✅ yes | Desktop source preview + GitHub Actions release builds. |
| `ErnestKostevich/horizon-pro` | **private** | ✅ yes | Your master copy of the desktop app, full source with Pro features. |
| `ErnestKostevich/HorizonWebMarketplace` | **private** | ✅ yes | FastAPI backend + Next.js web frontend for `horizonaai.dev` + `api.horizonaai.dev`. |
| `ErnestKostevich/horizon-plugin-sdk` | **public** | ❌ need to create | Public SDK so community creators can build plugins. |

---

## 1. `ErnestKostevich/horizon-genesis` (public)

**What it is:** the source-preview repository. Read-only for users, the
source of the GitHub Releases artifacts.

**What lives in it:**
- Full desktop source code **EXCEPT** the Pro-only handlers gated by the
  license manager (they are present, but guarded — see `src/main/main.js`
  top-of-file `PRO_HANDLERS` set).
- CI workflow (`.github/workflows/release.yml`) that builds Windows, macOS
  (Intel + Apple Silicon), and Linux (AppImage + deb) on tag push.
- License manager (`src/main/licenseManager.js`), UI pages
  (`progate.html`, `setup.html`, `chat.html`), marketplace client
  (`src/main/marketplaceApi.js`).
- `BACKEND_SPEC.md`, `BACKEND_SPEC_MARKETPLACE.md`, `DEPLOYMENT.md`,
  `REPOS_SETUP.md`, `WEBSITE_PLAN.md` (this doc and siblings).

**What does NOT live in it:**
- NOWPayments API key or IPN secret (env vars, never committed).
- Any real user data.
- `src/main/build-info.json` — created by CI only. Cloned source has no
  such file → the app boots into "source preview" mode.

**First-run flow for a user cloning this repo:**
1. `npm install`
2. `npm start`
3. App shows the **source-preview** splash screen (audit-only).
4. To run a real build, download the installed artifact from the
   GitHub Releases page.

**Release flow (Ernest):**
1. Make changes in `horizon-pro` or here (they stay in sync — see §2).
2. `git tag v1.x.x && git push origin v1.x.x`
3. CI builds all platforms, uploads to Releases.

---

## 2. `ErnestKostevich/horizon-pro` (private)

**What it is:** your full, un-guarded master copy. The place you do
development when you're working on sensitive/experimental features you
don't want the preview-reader audience to see yet.

### Recommended layout

Option A (simplest): **keep it in sync with `horizon-genesis`**. Use one
working folder, push to both remotes.

```powershell
# One-time setup in D:\Genesis\horizon-genesis-public
git remote add pro https://github.com/ErnestKostevich/horizon-pro.git
```

Then push to both:
```powershell
git push origin main
git push pro    main
```

Option B: **real private mastercopy with extra Pro-only files**.
- Start with an exact copy of `horizon-genesis`.
- Add directories that live ONLY here:
  - `src/pro/` — Pro-only features you are NOT ready to publish (e.g.
    experimental agent loops, paid-tier models).
  - `scripts/publish-public.js` — a helper that copies the repo to
    `horizon-genesis-public/`, stripping `src/pro/` before committing.
- Release flow becomes: develop in `horizon-pro` → run the publish
  script → commit+push in `horizon-genesis` → tag release.

**For now, start with Option A.** You can switch to B later without
losing anything.

---

## 3. `ErnestKostevich/HorizonWebMarketplace` (private)

**What it is:** the backend **and** the web frontend for
`horizonaai.dev` and `api.horizonaai.dev`.

Structure suggestion:

```
HorizonWebMarketplace/
├─ backend/                  ← FastAPI (deploys to Render)
│  ├─ app/
│  │  ├─ main.py             ← FastAPI app + routes
│  │  ├─ routers/
│  │  │  ├─ auth.py          ← /api/auth/*
│  │  │  ├─ license.py       ← /api/license/*
│  │  │  ├─ plugins.py       ← /api/plugins/*
│  │  │  ├─ creators.py      ← /api/creators/*
│  │  │  ├─ admin.py         ← /api/admin/*
│  │  │  └─ webhooks.py      ← /api/webhooks/nowpayments
│  │  ├─ models.py           ← pydantic models
│  │  ├─ db.py               ← motor (async Mongo client)
│  │  ├─ auth.py             ← JWT issue/verify, get_current_user
│  │  └─ nowpayments.py      ← client for NOWPayments API + Mass Payouts
│  ├─ requirements.txt
│  └─ render.yaml            ← Render deploy config
│
├─ web/                      ← Next.js 14 (deploys to Cloudflare Pages)
│  ├─ app/                   ← App Router pages — see WEBSITE_PLAN.md
│  ├─ components/
│  ├─ lib/
│  │  └─ api.ts              ← typed client for backend
│  ├─ public/
│  ├─ package.json
│  └─ next.config.js
│
└─ README.md
```

### Deploy targets
- **Backend:** Render (web service). Env vars: `MONGODB_URI`,
  `JWT_SECRET`, `NOWPAYMENTS_API_KEY`, `NOWPAYMENTS_IPN_SECRET`,
  `R2_ACCESS_KEY`, `R2_SECRET_KEY`, `TURNSTILE_SECRET`.
- **Frontend:** Cloudflare Pages. Env vars: `NEXT_PUBLIC_API_URL`,
  `NEXT_PUBLIC_TURNSTILE_SITE_KEY`.
- **DNS:** Porkbun → Cloudflare nameservers. Then CF DNS:
  - `api.horizonaai.dev` → CNAME to Render URL (proxied OFF — webhook
    signatures break through CF in some setups; if CF proxy is needed
    later, enable "Bypass cache" for `/api/webhooks/*`).
  - `horizonaai.dev` → CNAME to CF Pages (proxied ON — free DDoS).

**Turn on Cloudflare's proxy ("orange cloud") for the web frontend, NOT
for the API webhook route.** If you want to proxy the API domain too,
create a page rule to disable caching and bot-fight for
`api.horizonaai.dev/api/webhooks/*`.

---

## 4. `ErnestKostevich/horizon-plugin-sdk` (public — **to be created**)

**What it is:** types, CLI, and examples so community creators can build
plugins against the Horizon plugin system.

Structure:

```
horizon-plugin-sdk/
├─ packages/
│  ├─ types/                ← TypeScript types for the plugin manifest + tool API
│  │  ├─ src/index.ts
│  │  └─ package.json       ← @horizonai/plugin-types
│  └─ cli/                  ← `hz-plugin` CLI (init / build / publish)
│     ├─ src/
│     │  ├─ commands/
│     │  │  ├─ init.ts      ← hz-plugin init my-plugin
│     │  │  ├─ build.ts     ← hz-plugin build → .hzplugin bundle
│     │  │  └─ publish.ts   ← hz-plugin publish → POST /api/plugins/publish
│     │  └─ index.ts
│     └─ package.json       ← @horizonai/plugin-cli
├─ examples/
│  ├─ hello-world/
│  ├─ weather-tool/
│  └─ browser-macro/
├─ docs/
│  ├─ getting-started.md
│  ├─ manifest.md
│  ├─ tools-api.md
│  └─ publishing.md
├─ LICENSE                  ← MIT
└─ README.md
```

**Bundle format (`.hzplugin`):** zip file with:
- `manifest.json` (name, id, version, tools, permissions)
- `main.js` (the tool implementations)
- `icon.png`
- `README.md`

See `src/main/pluginManager.js` in `horizon-genesis` for the expected shape.

---

## Creation commands (PowerShell)

Run from `D:\Genesis\`:

```powershell
# 1. Create and push the plugin SDK repo (scaffolded, empty content — fill later)
cd D:\Genesis
mkdir horizon-plugin-sdk
cd horizon-plugin-sdk
git init
@"
# Horizon Plugin SDK

Build plugins for [Horizon Genesis](https://horizonaai.dev).

## Packages
- \`@horizonai/plugin-types\` — TypeScript types for the plugin manifest and tool API.
- \`@horizonai/plugin-cli\` — \`hz-plugin\` CLI for scaffolding, building, and publishing plugins.

## Quick start
\`\`\`
npx @horizonai/plugin-cli init my-plugin
cd my-plugin
npm run build
npx @horizonai/plugin-cli publish
\`\`\`

See the [docs](./docs/getting-started.md) for details.

## License
MIT.
"@ | Out-File -Encoding utf8 README.md
@"
MIT License

Copyright (c) 2026 Ernest Kostevich

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the 'Software'), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND.
"@ | Out-File -Encoding utf8 LICENSE
git add .
git commit -m "chore: initial scaffold"
git branch -M main
git remote add origin https://github.com/ErnestKostevich/horizon-plugin-sdk.git
git push -u origin main

# 2. Add 'pro' remote to the existing public clone (Option A sync)
cd D:\Genesis\horizon-genesis-public
git remote add pro https://github.com/ErnestKostevich/horizon-pro.git
# (first push will come later in the commit step)
```

**Create the repositories on GitHub first** (github.com/new) with the
exact names above and the visibility column from the table. Then run
the push commands.

---

## Cross-repo dependency diagram

```
                 ┌─────────────────────────────┐
                 │ horizon-genesis  (public)   │ ← user downloads desktop artifacts
                 │  - source preview           │
                 │  - CI builds releases       │
                 └────────────▲────────────────┘
                              │ push (sync)
                 ┌────────────┴────────────────┐
                 │ horizon-pro  (private)      │ ← Ernest's mastercopy
                 └─────────────────────────────┘
                              │
                              │ talks HTTPS to
                              ▼
                 ┌─────────────────────────────┐
                 │ HorizonWebMarketplace       │
                 │  - backend/  (api.h…)       │ ← Render
                 │  - web/      (h…)           │ ← Cloudflare Pages
                 └────────────▲────────────────┘
                              │ publishes to
                              │
                 ┌────────────┴────────────────┐
                 │ horizon-plugin-sdk (public) │ ← creators build plugins here
                 │  - @horizonai/plugin-types  │
                 │  - @horizonai/plugin-cli    │
                 └─────────────────────────────┘
```

---

## What to do first

1. **Commit current changes in `horizon-genesis`** (command block at the
   end of `DEPLOYMENT.md` handles this).
2. **Push existing code** to `horizon-pro` as-is (`git push pro main`).
3. **Scaffold `horizon-plugin-sdk`** with the block above (empty but
   real repo so community bookmarks start pointing somewhere).
4. **Backend + web** development happens in `HorizonWebMarketplace` on
   your schedule — endpoints are specified in `BACKEND_SPEC.md` and
   `BACKEND_SPEC_MARKETPLACE.md`.
