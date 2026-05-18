# Getting started with Horizon

Horizon is a personal AI agent for your desktop and terminal. Bring
your own API key (or run fully local with Ollama), and get:

- a polished **desktop app** (Electron)
- a **terminal CLI + TUI** with streaming and markdown rendering
- a **headless HTTP API** for mobile / PWA / cron / VPS deployments

All three share the same memory, skills, personas, and provider keys —
configure once, use anywhere.

## Pick how you want to install

### Option 1 — Standalone binary (recommended for end users)

No Node.js, no git, no npm. Download one file for your OS.

**Windows (PowerShell)**
```powershell
iwr https://github.com/ErnestKostevich/horizon-genesis/releases/latest/download/horizon-win-x64.exe -OutFile $env:LOCALAPPDATA\horizon.exe
$env:LOCALAPPDATA\horizon.exe setup
```

**macOS Apple Silicon**
```bash
curl -L https://github.com/ErnestKostevich/horizon-genesis/releases/latest/download/horizon-macos-arm64 -o /usr/local/bin/horizon
chmod +x /usr/local/bin/horizon
horizon setup
```

**macOS Intel**
```bash
curl -L https://github.com/ErnestKostevich/horizon-genesis/releases/latest/download/horizon-macos-x64 -o /usr/local/bin/horizon
chmod +x /usr/local/bin/horizon
horizon setup
```

**Linux**
```bash
curl -L https://github.com/ErnestKostevich/horizon-genesis/releases/latest/download/horizon-linux-x64 -o /usr/local/bin/horizon
chmod +x /usr/local/bin/horizon
horizon setup
```

**Verify** the SHA256 alongside each binary (every release ships a `.sha256` file):
```bash
sha256sum -c horizon-linux-x64.sha256
```

### Option 2 — From source via the installer script

If you already have Node 22+ installed.

**Linux / macOS**
```bash
curl -fsSL https://raw.githubusercontent.com/ErnestKostevich/horizon-genesis/main/scripts/install-cli.sh | bash
```

**Windows (PowerShell)**
```powershell
iwr https://raw.githubusercontent.com/ErnestKostevich/horizon-genesis/main/scripts/install-cli.ps1 | iex
```

This clones into `~/.horizon-cli`, runs `npm ci --omit=dev`, and
symlinks `horizon`, `horizon-tui`, `horizon-serve` into your PATH.

### Option 3 — Desktop app (Electron)

For the full graphical experience with computer-use vision, plugin
hub, marketplace, etc:

→ Download installer from https://github.com/ErnestKostevich/horizon-genesis/releases

The CLI and desktop app **share the same data folder** — keys, memory,
skills, personas are visible to both.

## First-time setup

After installation, run:

```bash
horizon setup
```

The wizard walks you through:

1. **Pick a provider** with cost annotations — Gemini and Groq have free
   tiers and are recommended starting points. Local options (Ollama / LM
   Studio) cost zero but need you to run a model on your machine.
2. **Paste an API key** (or skip if you picked a local provider).
3. **Pick a persona** — JARVIS / Friday / Alfred / Sage / Pixel. Changes
   tone and style of every reply.
4. **Pick a language** — English or Русский.
5. **Your name** for personalisation.

Re-run `horizon setup` anytime to change any of these.

## Try it

### Quick chat

```bash
horizon chat "what's the capital of Lithuania?"
horizon chat "rewrite this email as a one-sentence summary" < draft.txt
```

In a TTY, you'll see tokens stream as they arrive, then the reply
re-rendered with markdown formatting.

### Full agent (multi-step + tools)

```bash
horizon agent "find every TODO in this repo and group by file"
horizon agent "summarise the last 10 commits to main" --auto-approve
```

Watch the plan get printed, then a live step rail with a gradient
spinner as each tool runs.

### Interactive TUI

```bash
horizon
```

Inside the TUI:

- Type plain text → single-turn chat with the active persona
- `/agent <task>` → switch to full agent loop
- `/skill list` → see installed skills
- `/persona alfred` → switch persona on the fly
- `/mem "yerba mate"` → semantic memory search
- `/help` for the full slash command list

### See your token spend

```bash
horizon cost                    # last 30 days
horizon cost --days 7           # last week
horizon cost --provider claude  # filter
horizon cost --json | jq        # machine-readable
```

The CLI logs every AI call to `<userData>/horizon-cost.jsonl` with
provider, model, token counts, and estimated USD cost.

### Auto-pick the cheapest available provider

Pass `--provider auto` (or set it as default with `horizon model auto`)
and Horizon tries:

1. local Ollama if you have a URL configured
2. local LM Studio if configured
3. Google Gemini if key set (free tier covers most casual use)
4. Groq if key set (free tier, very fast)
5. DeepSeek (cheapest paid)
6. Mistral / OpenRouter
7. Claude
8. OpenAI

First match wins. Lets you keep paid providers as a fallback while
saving 10× with Gemini-Flash for routine queries.

```bash
horizon chat "..." --provider auto
horizon agent "..." --provider auto
```

## Where things live

| File | What it stores |
|---|---|
| `<userData>/horizon-settings.json` | provider, model, persona, lang, prefs |
| `<userData>/horizon-keys.json` | encrypted API keys (AES-256-GCM, machine-bound) |
| `<userData>/horizon_memory.json` | 8-type memory (facts, memories, conversations, profile, FTS index, persona, workspace…) |
| `<userData>/horizon-cost.jsonl` | per-call cost log |
| `<userData>/skills/<id>/SKILL.md` | user-installed skills |
| `<workspace>/.horizon/memory.json` | workspace-bound memory (commit in git) |
| `<workspace>/.horizon/skills/<id>/` | workspace-scoped skills (commit in git) |
| `<workspace>/.horizon/rules.md` | project rules injected into every prompt |

`<userData>` =
- Windows: `%APPDATA%\horizon-ai\`
- macOS: `~/Library/Application Support/horizon-ai/`
- Linux: `~/.config/horizon-ai/`

## Run on a server

`horizon serve --port 18789 --token <secret>` boots an HTTP API with:

- `GET /api/version` – health and runtime info
- `POST /api/chat` – single-turn chat
- `POST /api/agent` – full agent loop, streams over SSE
- `POST /api/mem/search`, `GET /api/mem/profile`, etc.

Full VPS setup with systemd + nginx + TLS: see `docs/deploy.md`.

## Going further

- `docs/cli.md` — every subcommand and flag reference
- `docs/deploy.md` — production VPS deployment
- `docs/agent-mode.md` — how the multi-step agent loop works
- `docs/memory.md` — the 8-type memory architecture
- `docs/skills.md` — writing custom SKILL.md bundles
- `docs/voice.md` — wake-word + continuous talk mode (Electron only)
- `docs/plugin-sdk.md` — building plugins for the marketplace
