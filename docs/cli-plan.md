# Horizon CLI + TUI — Design Plan

> Status: design only. Code lands after the memory sprint completes.

## Context

Horizon today is an Electron desktop app. Competitors (Hermes Agent
TUI, OpenClaw CLI) offer:

- Server / headless deploy (`horizon serve`)
- Scripting (`horizon "task"` → pipeable)
- TUI for terminal users
- Lower memory footprint than full Electron

Without these, Horizon doesn't run on a VPS, can't be cron-driven on a
server, and isn't usable from SSH. This plan adds a single Node.js
entry point that exposes the entire agent runtime without Electron.

## Outcome — what the user can do after this lands

```
$ horizon "найди все TODO в проекте и сгруппируй"     # one-shot agent run
$ horizon chat "what's the weather in Vilnius?"        # single-turn chat
$ horizon agent "refactor src/auth.ts to async/await"  # full agent loop
$ horizon skill list                                   # browse skills
$ horizon skill run refactor-react                      # invoke a skill manually
$ horizon mem search "yerba mate"                       # semantic recall
$ horizon mem dump > backup.jsonl                       # export memory
$ horizon connect telegram --token xxx                 # configure a channel
$ horizon serve --port 18789                            # headless HTTP API
$ horizon                                              # launch TUI (no args)
```

## Architecture

### Single entry point

`bin/horizon.js` (registered in `package.json` `"bin"`). Distributed via:

1. **bundled with Electron app** — Horizon installer drops the binary
   into `%LOCALAPPDATA%/Horizon/bin/` and adds it to PATH. Reuses the
   Electron app's existing `node_modules` + main process code.
2. **standalone npm package** — `npm i -g horizon-cli`. Pulls a slim
   subset (no Electron deps) for users who only want CLI.

For dev: `npm run cli "task"` runs it locally without install.

### Shared runtime, not duplicate code

The key principle: CLI does NOT reimplement the agent loop. It imports
the same modules:

```
bin/horizon.js
  ├─ requires ../src/main/agent.js           (AgentMemory, dispatchTool, TOOL_DEFINITIONS)
  ├─ requires ../src/main/agentLoop.js       (runAgentLoop)
  ├─ requires ../src/main/skillsManager.js   (SkillsManager)
  ├─ requires ../src/main/embeddings.js      (EmbeddingService)
  ├─ requires ../src/main/runtime/headless.js (NEW — extracts main.js setup without Electron)
  └─ requires ../src/main/connectionsManager.js
```

The new file `src/main/runtime/headless.js` is the abstraction barrier.
It exports `createHorizonRuntime({userDataDir, settingsStore, keysStore})`
which currently lives inlined in `main.js`'s loadAgentModules. The CLI
imports this, NOT main.js.

For Electron's main.js: refactor to call `createHorizonRuntime` itself,
so both paths share the same wiring. No duplication.

### Settings + keys storage (cross-platform)

CLI uses the same `electron-store` data files BUT can't load
`electron-store` (Electron-only). Resolution:

- Use `conf` package directly (electron-store's underlying engine, works
  outside Electron).
- Path: `%APPDATA%/Horizon/horizon-settings.json` on Windows, matching
  what the Electron app writes. So a user who has set keys in the GUI
  can use the CLI immediately — settings are shared.

### TUI (ink-based)

`horizon` with no args → launch `bin/horizon-tui.js`. Built with
[`ink`](https://github.com/vadimdemedes/ink) (React-in-terminal):

- Persistent chat pane (left)
- Step rail (right) — shows live agent steps, mirrors Inspector
- Composer at the bottom — multiline, `Tab` to autocomplete commands
  / slash commands / skills
- Slash commands: `/skill`, `/persona`, `/model`, `/skills`, `/quit`
- Streaming responses (token-by-token via `onAiChunk` event)
- Cycle keys: `Ctrl+R` reflection toggle, `Ctrl+P` plan-act-gate toggle,
  `Ctrl+S` subagent panel

Why `ink` over `blessed`:
- React mental model = consistent with the Electron renderer's pattern
- Hot-reload during dev (`ink-cli`)
- Has gradients, spinners, tables, syntax-highlighted markdown
- Active maintenance (blessed is dormant)

Lightweight alternative if `ink` is too heavy: `prompts` for the input
plus printf-style output. Simpler but less polished.

### Headless HTTP API mode

`horizon serve --port 18789` boots:
- Express server on `127.0.0.1:18789`
- Same endpoints the Electron renderer uses via IPC — translated to
  HTTP POST. e.g. `POST /api/agent/run` body `{task, options}` →
  streams steps via Server-Sent Events.
- WebSocket on `/ws` for real-time step subscription
- Auth: bearer token via `HORIZON_TOKEN` env var (so headless deploys
  don't expose openly even on loopback)

This unlocks:
- Mobile companion (PWA hits the same endpoint, paired via QR)
- Server-side cron-driven jobs (`* * * * * horizon agent "check disk"`)
- Multi-device "Agent Mesh" (one server shared by desktop + mobile +
  browser clients)

## Commands and what they do

| Command | What it does |
|---|---|
| `horizon` | Launches TUI |
| `horizon "task"` | Shorthand for `horizon agent "task"` |
| `horizon chat "msg"` | Single-turn chat; prints reply to stdout. Streamable with `--stream` |
| `horizon agent "task" [--max-steps N] [--reflect/--no-reflect]` | Full agent loop, streams steps to stdout (json by default, `--human` for prettier output) |
| `horizon skill list [--scope user\|workspace\|builtin]` | List skills |
| `horizon skill run <id> [--task "..."]` | Force a skill on the next turn |
| `horizon skill new <id> [--type basic\|with-helpers]` | Scaffold new SKILL.md |
| `horizon mem search "query" [--limit N] [--semantic]` | Search memories |
| `horizon mem dump [--type facts\|memories\|conversations\|all]` | Export to stdout (JSONL) |
| `horizon mem forget --fact <key>` / `--memory <id>` | Forget |
| `horizon mem profile` | Print user profile JSON |
| `horizon connect <channel> [--token X]` | Configure messaging channel |
| `horizon model <provider> [--model X]` | Set active model |
| `horizon persona <id>` | Set active persona |
| `horizon serve [--port N] [--token X]` | Start HTTP API |
| `horizon version` | Print version + provider/model + key health |

Flags shared across commands:
- `--json` / `--text` / `--stream` — output format
- `--model X` — override model for this call
- `--persona X` — override persona for this call
- `--workspace path` — override `.horizon/` lookup

## Streaming output format

For `agent` and `chat --stream`:
- `--json` (default) prints one JSON object per line to stdout (NDJSON)
  each line = one step. Final line has `type: 'run-end'`.
- `--human` reformats the same stream into:
  - Spinner while thinking
  - Tool calls as `→ run_code(...)` indented
  - Tool results as `← result (1.2s, ok)`
  - Final answer as plain markdown
- `--quiet` only prints the final answer

## Permission gate in CLI

The Electron app's `withPermission` pops a dialog. In CLI, the same
gate prints a prompt:

```
[approve] run_code Python: 'os.system("rm -rf ...")'   (y/N/never):
```

`--auto-approve` flag for unattended cron use. `--never-approve` for
read-only mode.

## Phases of implementation

### Phase 1 — Runtime extraction (`src/main/runtime/headless.js`)
- Pull `loadAgentModules` out of main.js into a reusable factory.
- Electron main.js now calls it. CLI will too.
- ~1 day. Pure refactor, no new features.

### Phase 2 — Slim CLI (`bin/horizon.js`)
- One-shot `horizon agent / chat / skill / mem` commands.
- No TUI yet, plain stdout/stderr.
- ~2 days.

### Phase 3 — Settings shim
- Conf-based storage that reads/writes the same files as Electron.
- Test: set a key in GUI → CLI sees it. ~0.5 day.

### Phase 4 — TUI (`bin/horizon-tui.js`)
- Ink-based interactive shell, slash commands, streaming responses,
  step rail.
- ~3-4 days for "good enough"; another 2 for polish (gradients, color
  themes, settings UI inside TUI).

### Phase 5 — Headless HTTP API (`horizon serve`)
- Express + SSE/WebSocket.
- Translates each IPC handler to HTTP endpoint.
- Auth via bearer token. ~2 days.

### Phase 6 — Mobile PWA (separate folder `mobile/`)
- React PWA, hits headless API.
- QR-paired with desktop.
- ~5-7 days for v1.

### Phase 7 — Docs site + install instructions
- `docs.horizonaai.dev` (or extend the existing `/docs` route on
  the marketplace site) — Quick Start, Concepts, CLI reference.
- ~3-5 days.

Total: ~3-4 weeks of focused work for the whole stack.

## Constraints / risks

- **Electron-only modules.** Some modules (`electron-store`, `app`,
  IPC) only work in Electron. The headless runtime needs to abstract
  these. The refactor in Phase 1 is the critical gate; without it the
  rest fragments.
- **Native dependencies.** `node-pty`, `better-sqlite3`, others may
  need rebuild for the CLI's Node version. Plan to keep CLI on the
  same Node version as Electron bundles (currently Node 20).
- **Permission gate UX in CLI.** Interactive prompt for tool approval
  is awkward in pipelines. Auto-approve flag exists, but needs
  carefully scoped — never default-allow shell.exec.
- **TUI rendering.** Ink has ~5MB dependency footprint. If the CLI is
  meant to be lightweight, gate TUI as optional install (`horizon-cli`
  vs `horizon-cli-tui`).
- **Distribution.** Auto-update for CLI is tricky. v1 = manual `npm
  install -g`; v2 = self-update command.

## Killer features over Hermes/OpenClaw TUI

1. **Voice in TUI** — wake word detection (via the same chat-voice-wake
   logic) but headless. Talk to your terminal-Horizon. Hermes is mute.
2. **Skill picker as native autocomplete** — `Tab` after `/skill `
   shows fuzzy-searchable skill list with descriptions, like Cursor's
   slash menu.
3. **Approve from another device** — long-running task running on a
   server hits a permission gate → push notification to your phone →
   tap approve → server continues. Hermes makes you SSH back.
4. **Workspace memory** — `horizon` in any directory auto-loads
   `.horizon/memory.json`, `.horizon/rules.md`, `.horizon/skills/`.
   Cursor's per-project config without Cursor's lock-in.

## What we won't do

- A whole alternate UI framework. TUI is for terminal-native; the
  rich UX stays in Electron.
- Native Electron-app replacement. CLI complements, doesn't replace.
- Mobile native apps (React Native / Swift / Kotlin) — PWA is enough
  for v1.

---

Open question for prioritisation: which phase do we ship first after
memory? Options:

- **A) Phase 1 + 2 only (slim CLI no TUI)** → fastest visible win,
  ~3 days, unblocks scripting and `horizon serve` Phase 5.
- **B) Phase 1 + 2 + 4 (with TUI)** → ~1 week, big "look it has a TUI
  like Hermes" moment.
- **C) Phase 1 + 5 (headless serve, no CLI)** → ~3 days, prerequisite
  for mobile + server deploys, but no visible terminal experience.

Recommend (A) — get CLI shipped, then layer TUI as polish.
