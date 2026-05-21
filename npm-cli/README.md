<p align="center">
  <strong>Horizon AI</strong> &mdash; the personal AI agent that runs on <em>your</em> machine.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@horizonai/cli"><img src="https://img.shields.io/npm/v/@horizonai/cli?style=flat-square&color=8b5cf6&label=npm" alt="npm"/></a>
  <a href="https://github.com/ErnestKostevich/horizon-genesis/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-BUSL--1.1-blue?style=flat-square" alt="License"/></a>
  <a href="https://horizonaai.dev"><img src="https://img.shields.io/badge/web-horizonaai.dev-ec4899?style=flat-square" alt="Website"/></a>
</p>

---

`@horizonai/cli` is the npm distribution of the Horizon AI command-line
interface &mdash; the same `horizon` binary that ships with the Horizon
desktop app, packaged for `npm install -g`.

## Install

```bash
npm install -g @horizonai/cli
```

Then:

```bash
horizon setup        # pick a provider, paste your key (30 seconds)
horizon              # launch interactive TUI
horizon "task"       # one-shot agent task
horizon chat "msg"   # single-turn chat
horizon serve        # headless HTTP API on :18789
```

Requires **Node 20+**. On Apple Silicon and Windows, the install pulls
prebuilt `better-sqlite3` binaries &mdash; no native toolchain needed.

## What you get

- **25 AI providers + 300+ models via OpenRouter** &mdash; Claude, GPT,
  Gemini, Groq, DeepSeek, Mistral, Qwen, Perplexity, Cohere, Grok,
  Together AI, Fireworks, DeepInfra, Cerebras, SambaNova, Moonshot Kimi,
  Z.AI / GLM, Nebius, OpenRouter aggregator, Azure OpenAI, custom
  OpenAI-compatible endpoint, plus local Ollama / LM Studio / LocalAI.
- **8-type memory** &mdash; facts, episodic memories, conversations,
  semantic recall (256-dim embeddings), FTS index, user profile,
  persona memory, and per-workspace `.horizon/memory.json`.
- **Skills system** &mdash; three scopes (workspace / user / builtin),
  same SKILL.md format Anthropic uses, auto-pickup based on the query.
- **Plugin sandbox** &mdash; vm2-based isolation, granular permissions,
  signed marketplace plugins.
- **TUI** &mdash; keypress-based interactive shell, scrollback,
  in-chat search, multi-line composer, gradient spinner, markdown
  rendering.
- **Headless HTTP API** &mdash; `horizon serve` exposes the agent over
  JSON + Server-Sent Events for cron jobs, PWAs, and mobile clients.

## Bring your own keys

Horizon never proxies your traffic. Your API keys sit encrypted in your
OS user data directory (`%APPDATA%/horizon-ai/` on Windows,
`~/Library/Application Support/horizon-ai/` on macOS, `~/.config/horizon-ai/`
on Linux) and the agent talks directly to your chosen provider.

## Programmatic use

```js
const { createHorizonRuntime, defaultUserDataDir } = require('@horizonai/cli');

const runtime = createHorizonRuntime()({
  userDataDir: defaultUserDataDir(),
  workspaceDir: process.cwd(),
});
```

The runtime exposes the same API the CLI commands and the Electron app
use &mdash; agent loop, skills manager, memory DB, providers, plugins.

## Other install paths

```bash
# macOS / Linux Homebrew
brew tap ErnestKostevich/tap https://github.com/ErnestKostevich/horizon-homebrew-tap
brew install horizon

# Windows Scoop
scoop bucket add horizon https://github.com/ErnestKostevich/horizon-scoop-bucket
scoop install horizon

# Or download a standalone binary (no Node required)
# https://github.com/ErnestKostevich/horizon-genesis/releases/latest
```

## License

[BUSL-1.1](./LICENSE) &mdash; personal, educational, internal evaluation,
and non-commercial production use is free. Hosting Horizon as a paid
service or redistributing it commercially requires written permission.
Plugins and workflows built on top of Horizon are unrestricted.

## Links

- [Source code](https://github.com/ErnestKostevich/horizon-genesis)
- [User docs](https://github.com/ErnestKostevich/Horizon-Agent-Docs)
- [Website](https://horizonaai.dev)
- [Report a bug](https://github.com/ErnestKostevich/horizon-genesis/issues)
