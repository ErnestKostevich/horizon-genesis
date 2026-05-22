# Local development

How to iterate on Horizon AI without rebuilding the installer every time.

## Quick start

```bash
git clone https://github.com/ErnestKostevich/horizon-genesis.git
cd horizon-genesis
npm install
npm run rebuild:native   # ← REQUIRED once after install
npm start
```

> **You must run `npm run rebuild:native` once after `npm install`.**
> Horizon uses native modules (`better-sqlite3` for the Kanban queue and
> SQLite memory backend, `node-pty` for the workspace terminal). `npm
> install` compiles them against your system Node, but Electron 28 ships
> a different V8 / Node ABI (NODE_MODULE_VERSION 119). Without
> `rebuild:native`, you'll see `Kanban queue unavailable: NODE_MODULE_VERSION
> mismatch` in the console and Kanban + SQLite memory will silently
> degrade to JSON-only mode. The app still runs, but those subsystems
> are off.

`npm start` launches Electron against the source tree directly. The window
opens, DevTools attaches detached, and a `[Horizon dev]` line in the
renderer console summarises the reload bindings.

## Seeing your edits

The Electron app has two processes — main and renderer — and they
reload differently.

### Renderer changes (HTML / CSS / `src/renderer/pages/*.js`)

Press **Ctrl+R** (Cmd+R on macOS) in the app window. The renderer reloads,
re-fetches every script + stylesheet from the in-process HTTP server, and
your edit is live in under a second.

If you suspect cached assets are stale — sometimes happens when you edit
a `.css` file inside Monaco-mode — use **Ctrl+Shift+R**. That bypasses the
HTTP cache. You should rarely need it; the dev server sets
`Cache-Control: no-cache` on every static asset by default.

### Main-process changes (`src/main/**/*.js`, including `ipc/*`, `tools/*`, `runtime/*`)

You must fully restart the app:

```bash
# Ctrl+C in the terminal running `npm start`, then:
npm start
```

There's no hot-reload for the main process — Electron loads main.js once
and any subsequent change requires re-launching the process. Watching a
file with `nodemon` doesn't help because Electron's IPC handlers are
registered once at boot.

### Preload script changes (`src/main/preload.js`)

Same as main process — full restart. The preload is loaded once per
window creation and isn't re-evaluated by Ctrl+R.

## Workflow tips

- **Iterate on renderer first.** Most UI/UX work is HTML/CSS/JS in
  `src/renderer/pages/`. Ctrl+R is your friend.
- **Keep DevTools open.** The detached DevTools window gives you the
  console + network tab + element inspector for free in dev mode.
- **Watch the main-process console.** It's the terminal where you ran
  `npm start`. IPC errors, plugin loading, agent runtime — all logged
  there.
- **Use `console.warn` not `console.error` for "expected failures."**
  electron-log streams console.error to a notification on Windows; warn
  stays in the terminal.

## Native modules

Horizon uses three optional native modules: `better-sqlite3`,
`node-pty`, and `uiohook-napi`. If you see `ERR_DLOPEN_FAILED` with a
"NODE_MODULE_VERSION mismatch" message, you need to rebuild them for
Electron's embedded Node ABI:

```bash
npm run rebuild:native
```

That runs `electron-rebuild -f -w node-pty -w better-sqlite3`. It does
not currently include `uiohook-napi` because the macro recorder uses it
lazily — install + rebuild manually only if you're working on recorder
features:

```bash
npx electron-rebuild -f -w uiohook-napi
```

The system `npm test` runs against your system Node, not Electron's
Node. If you've rebuilt the native modules for Electron, `npm test`
will fail on better-sqlite3 — that's expected and not a regression. To
run the SQLite tests, temporarily rebuild for the system Node:

```bash
npm rebuild better-sqlite3
```

…then switch back with `npm run rebuild:native` before launching the
app again.

## Building installers

```bash
npm run build:win           # NSIS installer (Windows)
npm run build:win:portable  # Portable .exe (Windows)
npm run build:mac           # DMG (macOS)
npm run build:linux         # AppImage + deb (Linux)
```

Each command runs `stamp-build-info.js` first so the resulting binary
is marked as an "official build" — the source-preview gate in main.js
checks for `src/main/build-info.json` and refuses to boot the full app
without it. (Source clones see a preview window instead.)

## Common gotchas

- **"Mode picker doesn't open."** You're on the chat surface and you
  clicked the header surface chip. As of the latest build, that chip
  opens the mode picker; if it still doesn't respond, hard reload with
  Ctrl+Shift+R to bust any stale cached HTML.
- **"Code changes don't show."** You edited a main-process file (look at
  the path — anything under `src/main/` outside `src/renderer/pages/`).
  Restart with `npm start`.
- **"The installer build is silent / exits immediately."** The portable
  build needs `better-sqlite3` and `uiohook-napi` in `asarUnpack` so
  the native `.node` files are loadable at runtime; this is configured
  in `package.json` `build.asarUnpack`. If you've added new native
  dependencies, extend that list.
