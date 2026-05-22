# Ink-based TUI prototype

This directory holds an experimental Ink (React-for-the-terminal) port of
the readline-based TUI in `bin/horizon-tui.js`. It exists to answer one
question: **should we replace the keypress-driven TUI with Ink, ship both,
or shelf the idea?**

It is NOT a drop-in replacement. The agent loop, slash command surface,
scrollback search, mouse handling, and altscreen are stubbed. The
skeleton proves the architecture works.

## How to run

From source (Node 20+):

```
node bin/horizon.js tui --ink
# or directly:
node -e "require('./bin/horizon.js')" --   # uses CJS dispatch
node bin/tui-ink-launcher.cjs              # standalone launcher
```

The `--ink` flag on `horizon tui` is wired in `bin/horizon-tui.js` and
dynamically imports `bin/tui-ink/index.mjs`. The launcher script avoids
the rest of the readline machinery for clean comparison.

## What's in the box

```
bin/tui-ink/
├── index.mjs           — start({ runtime, flags }) → renders <App />
├── App.mjs             — top-level component, state + dispatch
├── components/
│   ├── Banner.mjs      — wordmark + 4 collapsible sections + greeting
│   ├── StatusBar.mjs   — 2-row bordered status bar
│   ├── Composer.mjs    — bordered input with prompt arrow
│   ├── ChatLine.mjs    — single transcript line (user / assistant / system)
│   └── ToolCard.mjs    — bordered tool-call box with status + duration
├── hooks/
│   ├── useTheme.mjs    — pulls active theme from runtime, exposes RGB
│   └── useStream.mjs   — token stream buffer (placeholder)
└── README.md           — this file
```

All `.mjs` because Ink 7 + ink-text-input + ink-spinner are ESM-only.
The rest of horizon-genesis is CommonJS, so the CJS launcher in
`bin/horizon-tui.js` dynamic-imports `index.mjs` via
`await import('./tui-ink/index.mjs')`.

No JSX. Components use `React.createElement(...)` directly so the
prototype runs with **zero build pipeline** (no Babel, no esbuild).

## Reuses

- `bin/lib/banner.js` → `bannerFramedBox()`, `buildGreetingBase()`, `renderArt()`
- `bin/lib/markdown.js` → `renderMarkdown()` for assistant lines
- `bin/lib/themes.js` → theme RGB tuples + `ctxFor(model)`
- `bin/lib/tty.js` → `friendlyError()`
- `src/main/runtime/headless.js` → `createHorizonRuntime`

ANSI escape codes from those CJS modules render through Ink's `<Text>`
verbatim — the wordmark looks identical to the readline TUI.

## Slash commands (skeleton)

| Command         | Behaviour                                              |
|-----------------|--------------------------------------------------------|
| `/help`         | shows the prototype command list                       |
| `/quit`         | exits the TUI cleanly via `useApp().exit()`            |
| `/clear`        | clears the scrollback                                  |
| `/reset`        | clears scrollback + adds a "session reset" line        |
| `/demo-tool`    | renders a sample ToolCard (proves the layout works)    |
| `/demo-stream`  | simulates a streaming reply (proves Spinner + redraw)  |

Anything else is echoed back through a fake "you said: X" assistant
line — the agent loop is not wired yet.

## pkg compatibility

**Status: unverified — likely BROKEN.**

`@yao-pkg/pkg` snapshots a CJS module graph. Ink 7, React 19, ink-text-input,
and ink-spinner are all `"type": "module"` ESM-only packages. There is no
realistic path to bundling them through pkg without one of:

1. **Downgrade**. Use Ink v3 (CJS-compatible). Drops a lot of the modern
   layout primitives but is the path of least friction.
2. **Bundle to CJS first.** Run `esbuild bin/tui-ink/**/*.mjs --bundle
   --format=cjs --platform=node --external:better-sqlite3 --external:node-pty`
   before pkg. Output a single `dist-tools/ink-tui.cjs` and require()
   that from `bin/horizon.js`. Maintainable but adds a build step.
3. **Ship two flavours.** `npm i -g @horizonai/cli` (Node 20+) gets the
   Ink TUI. The downloadable .exe / .dmg / AppImage from `pkg` gets the
   readline TUI as a graceful fallback. The same `--ink` flag exists in
   both; under pkg it prints "Ink unavailable in single-binary build —
   use npm install instead" and falls back.

**Decision recommendation**: option 3. The .exe distribution is for the
"download and run" cohort who don't have Node — they get the proven
readline TUI. The `npm` distribution is for developers who want the
prettier experience.

## Pros vs readline TUI

| Aspect                  | Readline TUI             | Ink TUI                       |
|-------------------------|--------------------------|-------------------------------|
| Layout                  | Manual ANSI positioning  | FlexBox-style declarative     |
| Components              | Single 2400-line file    | Composable React components   |
| Borders / boxes         | Hand-drawn box-draw      | `<Box borderStyle="round">`   |
| State management        | Mutable engine class     | useState / props              |
| Scrollback              | Custom transcript buffer | `<Static>` (built-in)         |
| Mouse                   | SGR-1006 hand-parsing    | Not yet (community pkg)       |
| ANSI colors             | Hand-applied             | Pass-through still works      |
| pkg-bundleable          | Yes                      | No (without esbuild step)     |
| Bundle size             | 0 extra deps             | +46 packages (~5MB unpacked)  |
| Maintenance burden      | High (one giant file)    | Lower (small components)      |
| Visual ceiling          | Capped by manual ANSI    | Theme primitives, animations  |

## Side-by-side screenshots

(Placeholder — capture after a 5-minute pkg test run on Windows
Terminal + macOS Terminal.app.)

```
─── readline TUI ─────────────────────────────────────────────────
╭──────────────────────────────────────╮
│ ⌁ horizon · v0.0.1                   │
│   the agent that learns who you are  │
╰──────────────────────────────────────╯

  ▸ Tools          built-in · 24 channels · 12 MCP
  ▸ Skills         8 enabled · /skills to manage
  ▸ System prompt  jarvis · workspace Genesis
  ▸ MCP servers    none configured

  Good evening, sir.
  ⏎ send  ·  ⇧⏎ newline  ·  /help  ·  Esc interrupt

> _

─── Ink TUI ──────────────────────────────────────────────────────
╭──────────────────────────────────────╮
│ ⌁ horizon · v0.0.1                   │
│   the agent that learns who you are  │
╰──────────────────────────────────────╯

  ▸ Tools          built-in · 8 skills loaded
  ▸ Skills         8 enabled · /skills to manage
  ▸ System prompt  jarvis · workspace horizon-genesis
  ▸ MCP servers    none configured

  Good evening, sir.
  ⏎ send  ·  ⇧⏎ newline  ·  /help  ·  Esc interrupt

· Ink TUI prototype ready. Type /help for commands, /quit to exit.
╭────────────────────────────────────────────────────────────────╮
│ ● ready  ·  gemini:auto  ·  jarvis  ·  ~/Genesis  (main)        │
│ 0 tokens  ·  ▱▱▱▱▱▱▱▱▱▱  ·  $0.0000  ·  1 msgs  ·  theme:default│
╰────────────────────────────────────────────────────────────────╯
╭────────────────────────────────────────────────────────────────╮
│ › Ask Horizon, or type / for commands                          │
╰────────────────────────────────────────────────────────────────╯
```

## Verdict

**Ship both.** Keep the readline TUI as the default for the .exe / .dmg
distribution where pkg-bundling is mandatory. Add `--ink` as an opt-in
flag for the `npm i -g` distribution where users have Node installed.
This trades zero release risk (readline TUI is proven) for a marketing
win (users who care about polish can flip the flag).

A future sprint can promote `--ink` to default when:
1. The Ink agent loop wiring is at parity with the readline surface.
2. esbuild-bundled CJS output ships in `dist-cli/` alongside `pkg`.
3. The mouse / altscreen story is solved (community ink-mouse package or
   bespoke wrapper around stdin SGR sequences).
