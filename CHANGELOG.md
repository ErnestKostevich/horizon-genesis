# Changelog

All notable changes to Horizon AI will be documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.0.1] - 2026-05-20

First public release. This is the foundation — Horizon AI is a desktop
agent that runs on your machine, talks to whichever AI provider you
choose, and learns over time. Sprint 1-7 highlights below; see
`docs/ultrareview-2026-05-20.md` (local-only) for the full review.

### Install paths — all public
- **npm** — `npm i -g @horizonai/cli` (cross-platform, Node 20+)
- **Homebrew** — `brew tap ErnestKostevich/tap && brew install horizon` (macOS / Linux)
- **Scoop** — `scoop bucket add horizon https://github.com/ErnestKostevich/horizon-scoop-bucket && scoop install horizon` (Windows)
- Standalone binaries — Win-x64, macOS-x64, macOS-arm64, Linux-x64 via @yao-pkg/pkg
- Desktop installers — NSIS + portable (Windows), DMG (macOS), AppImage + deb (Linux)

### CLI first-run UX (hotfix, retagged cli-v0.0.1)
The first cli-v0.0.1 binaries shipped with a hard-to-reach setup path: the
binary launched, painted the banner, and on some Windows terminals exited
straight back to the prompt with no way to add an API key. The retag fixes
this end-to-end:
- **`horizon` with no API key now auto-runs the setup wizard** instead of
  dropping into an empty TUI. Detects 21 keyed providers + local
  Ollama/LM Studio/LocalAI URLs.
- **TUI raw-mode is defensive** — `setRawMode` is wrapped in try/catch
  and falls through to a plain readline interface when the terminal
  can't enter raw mode (common with pkg-bundled binaries on Windows).
  Previously this silently exited the process.
- **Plain-mode TUI shows a visible `›` prompt** and a welcome line so
  users know they can type.
- **Cryptic provider errors get translated.** "HTTP 429" → "Rate limit
  hit — your provider is throttling. Tip: wait 30–60 seconds, or switch
  with `horizon model <id>`." Same treatment for 401/403/404/408/5xx
  plus DNS/network/timeout cases.
- **Punycode deprecation warning suppressed** — it was cluttering every
  launch.
- `HORIZON_SKIP_SETUP=1` / `--no-setup` opts out of the first-run wizard
  for headless CI / Docker images that pre-mount keys.

### Memory — 9 layers
- **Facts** — stable key/value preferences
- **Episodic memories** — time-stamped events
- **Conversations** — chat history (FTS-indexed)
- **Semantic embeddings** — 256-dim vectors (OpenAI 3-small or Gemini)
- **FTS index** — in-memory inverted index + SQLite FTS5 mirror with bm25 search
- **User profile** — Big Five personality + communication style
- **Persona memory** — per-persona overlays
- **Workspace memory** — committable `.horizon/memory.json` per project
- **Dialectic model** — Honcho-style diff log of what the agent has learned over time
  (multi-level theory-of-mind: 0=user, 1=user→agent, 2=recursive; multi-tenant)

### Storage — SQLite-first (Sprint 7B)
- SQLite + FTS5 — primary store, source of truth, auto-migrates legacy `memory.json` on first boot
- JSON file — now export-only, archived as `memory.json.legacy.<ts>` after migration
- Embeddings sidecar — 256-dim Float32 vectors per memory key
- Opt-out: `HORIZON_MEMORY_BACKEND=json` flips it back for migrations or debugging

### AI providers — 25 direct + OpenRouter
- Claude (Sonnet 4.6 / Opus 4.7 / Haiku 4.5) · OpenAI · Gemini · Groq
- DeepSeek · Mistral · Qwen · Grok · Perplexity · Cohere
- Together · Fireworks · DeepInfra · Cerebras · SambaNova · Moonshot
- Z.AI · Nebius · Azure · plus custom-endpoint provider
- OpenRouter wrapper for 300+ additional models
- Auto-routing — `--provider auto` picks free/local first

### Messaging channels — 7 live runtimes
- Telegram — Bot API + chat viewer
- Discord — Gateway WebSocket
- Slack — Socket Mode (xapp + xoxb)
- WhatsApp — Twilio (BYOK)
- Signal — self-hosted signal-cli bridge (BYOK)
- iMessage — macOS Messages.app via osascript
- Email — IMAP inbound + SMTP outbound (imapflow + nodemailer)

### Sandbox executors — 6 backends
- Host — direct (default)
- Docker — sandboxed containers
- SSH — remote machine
- Modal — serverless cloud (BYOK)
- Daytona — dev workspaces (BYOK)
- Singularity / Apptainer — HPC clusters

### Computer use — depth (Sprint 7)
- Wake word — Deepgram + Groq Whisper
- Continuous talk mode
- TTS — ElevenLabs · OpenAI · system · Kokoro
- Screen capture + vision-based smart click
- **OCR** — Tesseract.js for reading text from screenshots
- **Multi-display** — drive secondary monitors, capture per-display
- **Macro recorder / replayer** — record mouse + keyboard sequences, play back deterministically
- Mouse / keyboard / window control via uiohook-napi
- Live Canvas — shared editable surface with the agent

### Personas
- 5 built-in: JARVIS · Friday · Alfred · Sage · Pixel
- Persona editor in Settings — custom prompts, allowed tools, per-persona memories

### Skills — 30 first-party, 3 scopes
- 30 SKILL.md bundles in `builtin-skills/` — code (10), writing (5), research (3),
  productivity (4), communication (3), personal (2), creative (1), ops (1), edu/fin (2)
- Headline skills: commit-message, code-review, pr-description, refactor-react,
  security-scan, web-research, slack-summary, telegram-digest, journal-prompt,
  tutor-mode, mcp-builder, doc-coauthoring, debug-helper, weekly-review, …
- 3 scopes: workspace · user · built-in
- Progressive disclosure tools: `self_describe`, `self_list_capabilities`,
  `self_read_skill`, `self_read_persona`
- **Skill self-improvement** — agent refines its own SKILL.md based on usage
- Auto-skill suggester — detects repeating patterns, prompts to save as a skill
- agentskills.io importer / exporter + ClawHub importer + security scanner

### Workflows — 5 first-party + cron
- 5 first-party workflows in `builtin-workflows/`: morning-briefing,
  code-review-on-pr, weekly-retrospective, inbox-zero, deploy-guardian
- No-code workflow builder (GUI)
- Cron runner — scheduled tasks via CLI (`horizon cron daemon`)

### MCP support
- Configure + spawn MCP servers
- Live tool discovery + caching
- Works in Electron AND CLI/headless (same registry)

### CLI + headless server
- 50+ subcommands, full feature parity with Electron
- TUI mode — keypress-based composer + mouse + history
- `horizon serve` — headless HTTP API + SSE for 24/7 server-agent mode
- Standalone binaries for Win/Mac-x64/Mac-arm64/Linux (no Node required)

### Mobile PWA
- QR-pair phone to desktop app or VPS over LAN
- Same chat, same memory, same agent
- Lives in `mobile/`, served by `horizon serve`

### Plugin SDK + Marketplace
- TypeScript SDK + CLI scaffolder ([`horizon-plugin-sdk`](https://github.com/ErnestKostevich/horizon-plugin-sdk))
- **vm-based plugin sandbox** — community plugins are safe-by-default. No host
  globals, no `require('fs'|'net'|'electron')`, abortable runaway loops, isolated
  per-plugin `ctx = { settings, fetch, logger, storage }`. Opt-out via
  `HORIZON_PLUGIN_NO_SANDBOX=1`.
- Plugin + skill marketplace at horizonaai.dev
- Crypto-only payouts via NOWPayments (USDT TRC20/BSC/TON/SOL)
- 70/30 author/platform split

### Multi-agent — Durable Kanban (Sprint 7)
- `spawn_subagent` tool + persistent Kanban queue
- Subagents survive a parent crash — restart the host and the queue resumes
- WAL-backed in `memory.sqlite`

### CLI themes — 8 themes
- `default` (deep blue-violet), `mono`, `light`, `kawaii` (pink kaomoji),
  `matrix` (green on black), `retro-amber` (CRT warmth), `vapor` (synthwave),
  `mocha` (Catppuccin Mocha)
- Toggle with `horizon theme <name>` or in Settings

### Code refactor (Sprint 6)
- `src/main/main.js` split from **6,751 lines → 3,042 lines** (~55% reduction)
- IPC handlers extracted into `src/main/ipc/*.js` (12 modules)
- Agent tools extracted into `src/main/tools/*.js` (11 modules)
- Dead code purge — ~1,000 LOC removed (`fractal-bg.js`, `chat-cursor-v2/v3.css`, nutrition tool, Wikipedia tool)

### License
- **BUSL-1.1** (Business Source License 1.1) — source-visible, free for
  personal / educational / internal-evaluation use; commercial deployments
  need a written licence agreement with the author.

### Security
- All API keys encrypted via OS-bound `safeStorage` + `electron-store` (AES-256-GCM)
- Per-plugin permission manifests; user approves before install
- vm-based plugin sandbox enforces capability boundaries at the JS engine level
- No telemetry, no phone-home, no analytics
- Local-first: nothing leaves your machine except your own API calls

### Tests
- **178/178 unit tests** + **36/36 integration tests** passing
- `test/unit/` covers memory layers, FTS, SQLite, dialectic, reviewer, channels,
  providers, plugin sandbox, kanban queue, macro format, OCR, cost tracker, markdown
- `test/integration/` covers CLI smoke + serve API end-to-end

### Known limitations
- macOS builds are **ad-hoc signed** — right-click → Open to bypass Gatekeeper.
  Apple Developer ID will land once Horizon earns enough revenue to justify it.
- Linux AppImage on Ubuntu 22.04+ needs `libfuse2` (`sudo apt install libfuse2`)
- Some Hermes Agent features are roadmapped (recursive multi-level ToM diff
  extraction, multi-tenant Honcho when used in `horizon serve`)
- No auto-update yet — manual download from GitHub Releases

[Unreleased]: https://github.com/ErnestKostevich/horizon-genesis/compare/v0.0.1...HEAD
[0.0.1]: https://github.com/ErnestKostevich/horizon-genesis/releases/tag/v0.0.1
