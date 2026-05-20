# Changelog

All notable changes to Horizon AI will be documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.0.1] - 2026-05-20

First public release. This is the foundation — Horizon AI is a desktop
agent that runs on your machine, talks to whichever AI provider you
choose, and learns over time.

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

### Storage — hybrid by default
- JSON file (human-readable, edit in any editor) — source of truth
- SQLite + FTS5 mirror — auto-rebuilt on boot, live-synced on each write
- Embeddings sidecar — 256-dim Float32 vectors per memory key

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

### Computer use
- Wake word — Deepgram + Groq Whisper
- Continuous talk mode
- TTS — ElevenLabs · OpenAI · system · Kokoro
- Screen capture + vision-based smart click
- Mouse / keyboard / window control
- Live Canvas — shared editable surface with the agent

### Personas
- 5 built-in: JARVIS · Friday · Alfred · Sage · Pixel
- Persona editor in Settings — custom prompts, allowed tools, per-persona memories

### Skills
- Auto-loaded markdown bundles (SKILL.md)
- 3 scopes: workspace · user · built-in
- Progressive disclosure tools: `self_describe`, `self_list_capabilities`,
  `self_read_skill`, `self_read_persona`
- **Skill self-improvement** — agent refines its own SKILL.md based on usage
- Auto-skill suggester — detects repeating patterns, prompts to save as a skill
- agentskills.io importer / exporter

### Workflows + cron
- No-code workflow builder (GUI)
- Cron runner — scheduled tasks via CLI

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
- QR-pair phone to desktop app over LAN
- Same chat, same memory, same agent

### Marketplace
- Plugin + skill marketplace at horizonaai.dev
- Crypto-only payouts via NOWPayments (USDT TRC20/BSC/TON/SOL)
- 70/30 author/platform split

### Security
- All API keys encrypted via OS-bound `safeStorage` + `electron-store`
- Per-plugin permission manifests; user approves before install
- No telemetry, no phone-home, no analytics
- Local-first: nothing leaves your machine except your own API calls

### Tests
- 106/106 unit tests passing
- `test/unit/` covers memory layers, FTS, SQLite, dialectic, reviewer, channels, providers

### Known limitations
- macOS builds are **ad-hoc signed** — right-click → Open to bypass Gatekeeper.
  Apple Developer ID will land once Horizon earns enough revenue to justify it.
- Linux AppImage on Ubuntu 22.04+ needs `libfuse2` (`sudo apt install libfuse2`)
- Some Hermes Agent features are roadmapped (recursive multi-level ToM diff
  extraction, multi-tenant Honcho when used in `horizon serve`)
- No auto-update yet — manual download from GitHub Releases

[Unreleased]: https://github.com/ErnestKostevich/horizon-genesis/compare/v0.0.1...HEAD
[0.0.1]: https://github.com/ErnestKostevich/horizon-genesis/releases/tag/v0.0.1
