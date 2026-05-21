# Horizon AI — Ultrareview 2026-05-20

Consolidated findings from 7 parallel research agents covering Hermes
internals, feature parity, docs gaps, Plugin SDK, marketplace catalog,
UX/visual audit, code tech debt, and TUI deep audit.

**Date:** 2026-05-20
**Horizon version:** v0.0.1 (Sprint 1 → Sprint 2.13 shipped)
**Hermes version benchmarked against:** v2026.5.16 "Foundation Release"

> This file is LOCAL only — kept in private docs/ (not Horizon-Agent-Docs
> public repo) to avoid telegraphing competitive plans.

---

## TL;DR

1. Hermes ahead on **breadth** (22 channels, 7 sandbox, 691 skills, 159k
   stars, pip install). Horizon ahead on **architecture** (9-layer
   memory, computer use + wake word, personas, crypto marketplace,
   mobile PWA, Electron GUI, Plugin SDK).
2. Hermes v2026.5.16 shipped `computer_use cua-driver` — our computer
   use moat is no longer infinite. Must deepen (OCR, multi-monitor,
   recordable macros).
3. **Plugin SDK has 4 critical lies-of-omission** — manifest on paper
   doesn't match runtime. Nobody can ship a working plugin from the
   docs. Fix is <1 day.
4. **Docs are mostly empty** — TOC promises 35 pages, 12 exist. Hosted
   site horizonaai.dev/docs returns 404 on most deep links.
5. **CSS cascade catastrophe** — 1,443 `!important` declarations, 5
   competing files, light theme broken in 30+ places.
6. **`main.js` = 6,751 lines of god object** — 250 IPC handlers in one
   file.
7. Sprint 2.13 visually 70% Hermes-like; 30% feel still missing:
   click-toggle sections, real modal chrome, live kawaii face in idle.

---

## 1. Hermes internals (top 10 to adopt)

1. `.bundled_manifest` + origin-hash protection (skill update without
   overwriting user edits)
2. `skill_manage patch` action (diff-only, not full rewrite)
3. Conditional skill activation in YAML (`fallback_for_toolsets`,
   `requires_toolsets`)
4. Three-level progressive disclosure (~3k metadata → full SKILL.md →
   refs on demand)
5. `hermes doctor` unified health check (we have it but less complete)
6. Skin/personality decoupling (`/skin` visual, `/personality` voice)
7. `[[as_document]]` / `[[audio_as_voice]]` directives in skill output
8. Bundles YAML grouping skills under one slash command
9. agentskills.io spec strict compliance (portable to ~40 agents)
10. Status bar green/yellow/orange/red thresholds at 50/80/95%
    (already in Sprint 2.13)

Frozen-snapshot memory pattern: load once at session start, never
mutate mid-session — preserves prefix cache. Document explicitly in
`workspaceMemory.js`.

## 2. Feature parity matrix 2026 — 27 rows

**Hermes wins:** channels (22 vs 7), sandboxes (+ Vercel), skills
catalog (691 vs 8), built-in tools (70+ vs 50+), docs site coverage,
community (159k stars).

**Horizon wins:** 9-layer memory, voice (wake + 4 TTS), computer use
depth, mobile PWA, GUI Electron, personas (5 + per-persona memory +
voice), crypto marketplace, Plugin SDK, theming (8 themes), Windows
first-class.

**Wash:** providers (Horizon 25 direct vs Hermes wrapper 200+ via
LiteLLM), MCP, cron, workflows, multi-tenant, headless server,
configuration.

## 3. Docs gaps — 23 missing pages

Existing (12): what-is-horizon, installation, getting-started,
providers, agent-mode, cli-reference, server-mode, connect-whatsapp,
faq, troubleshooting, pricing, support.

Missing (23+): per-provider setup (all 25), personas, voice/wake,
computer-use, 9-layer-memory, dialectic, workflows, cron, multi-profile,
mobile pairing, all 8 themes, 50+ subcommands reference, sandbox
modes, MCP servers, all channels (Telegram/Discord/Slack/Signal/
iMessage/Email/Notion), Plugin SDK overview, deploy/VPS,
publishing-to-marketplace, built-in skills/plugins, privacy.

**P0 docs (this week, 10 pages):**
1. concepts/personas.md
2. guides/computer-use.md
3. guides/voice-and-wake-word.md
4. reference/http-api.md
5. concepts/9-layer-memory.md
6. guides/cli-themes.md
7. guides/channels/telegram.md
8. guides/channels/discord.md
9. guides/local-models.md
10. reference/providers-full.md

## 4. Plugin SDK — 4 critical bugs

1. **`main.js` vs `handler.js` mismatch** — SDK builds `main.js`, host
   expects `handler.js`. No SDK-built bundle currently runs.
2. **Tool handler contract divergent** — SDK types say
   `module.exports = { toolName: ... }`, ALL 6 builtins use
   `execute(tool, args, ctx)`.
3. **`PluginContext.fetch/logger/storage` is fiction** — types
   advertise API that doesn't exist. Host gives only
   `ctx = { settings }`.
4. **Permission strings inconsistent** — SDK `network.fetch`, builtins
   `network:*`, docs `network:<host>`. 3 forms.

Plus: plugin sandbox not shipped → community plugins disabled by
default (`pluginManager.js:99`). Blocker for marketplace.

## 5. Marketplace catalog plan

**30 first-party skills** to author (categories: code 10, writing 5,
research 3, productivity 4, communication 3, personal 2, creative 1,
ops 1, edu/fin 2 — itemized in Sprint 5 plan).

**15 plugins** (notion-deep, linear, google-workspace, github-deep,
figma-extract, calendar-unified, obsidian-vault, whisper-local,
firecrawl, 1password-cli, n8n-bridge, stripe-readonly, discord-bot,
telegram-userbot, gmail-smart).

**10 workflows** (morning briefing, code review on PR, weekly
retrospective, inbox zero, content publishing, deploy guardian, daily
standup, research sprint, expense night, self-improving Horizon).

**Strategy:** don't out-build ClawHub. Federate as trusted curator.
30 first-party + 50 vetted ingest from VoltAgent awesome-openclaw-skills
list = 90 skills in 3 months. Defer paid creator marketplace until
catalog hits 100.

## 6. UX / visual top issues

**Electron:**
- Light theme broken in `chat-shell-polish.css:825-1196` (dark hex
  `!important`)
- 5 competing CSS layers — delete `chat-cursor-v2/v3.css`
- Skeletons defined but unused in most async surfaces
- Empty states for Plugin Hub / Skills / Workflows are blank
- Personas buried — no chip in composer
- Mobile PWA accent diverges (still `#8b5cf6→#ec4899`)
- Marketplace site uses Inter vs desktop Plus Jakarta

**CLI/TUI:**
- Status bar emoji 🗜/▶/⏱ break on cmd.exe
- `▎` ribbon prints twice in 2-row layout
- Section toggle only typed `/sections`, no click
- Banner re-prints WHOLE on each `/sections`
- Idle art hardcodes "still here, sir" (JARVIS-only)
- Time-of-day art every launch becomes noise
- `/help` mentions easter eggs (destroys them)
- `/clear` wipes transcript (breaks Ctrl+F)
- Kawaii face only in spinner, not idle
- Banner glyph `⌁` hardcoded (themes override doesn't show)

## 7. Code tech debt top 10

1. `main.js` 6,751 lines → split into `ipc/*.js`
2. `chat.html` 4,586 lines (2,700 inline `<script>`) → extract
3. `chat-base.css` 3,072 lines → split tokens/layout/components
4. `tui-engine.js` constructor 100+ instance fields
5. 34-case switch in `dispatchTool` → tool registry
6. 5-second `setTimeout` after shell approval (`main.js:3730`)
7. `loadAgentModules` chains 3 setTimeout
8. Provider registry hardcoded in 3 places
9. 3 near-identical channel runtimes
10. 122+ silent `catch (_) {}`

Dead code: `fractal-bg.js`, `chat-cursor-v2/v3.css`, nutrition,
Wikipedia tool — ~1,000 LOC to delete.

Tests: 5.6% LOC coverage. Main gaps: `dispatchTool`, `agentLoop`,
`executor`, `withPermission`, `mcpRegistry`, `licenseManager`.

## 8. Strategic recommendations

**3 features to add from Hermes (biggest ROI):**
1. `pip install horizon-ai` (via `npm i -g @horizonai/cli` + Homebrew
   + scoop)
2. Durable multi-agent Kanban runtime
3. SQLite-first memory (flip default — JSON becomes export)

**3 features to protect and deepen:**
1. Computer use moat — OCR, multi-monitor, recordable macros
2. Crypto marketplace — push 20-50 paid plugins before Hermes ships
   monetization
3. Persona system — marketplace personas, per-persona model
   preference

**3 features already better — promote:**
1. 9-layer memory — pin in README as #1 differentiator
2. 8 themes — Hermes has 0 documented, record 30-sec video
3. Plugin SDK — "build paid plugin in 10 min on crypto marketplace"
   is unique story

## 9. Sprint roadmap

### Sprint 3 — Foundation (1 week, P0)
- Plugin SDK 4 lies-of-omission fix
- Dead code purge (fractal-bg.js, chat-cursor-v2/v3.css, nutrition)
- Mobile PWA accent unification
- `/altscreen` `/sections` in SLASH_HINTS
- Fix light-theme `!important` overrides
- Write 10 P0 docs pages

### Sprint 4 — Visual Hermes parity (1 week)
- Click-to-toggle sections
- Centered modal /help with border + scroll
- Persona pill in composer
- Skeletons enabled on async surfaces
- Marketplace font swap to Plus Jakarta
- Live kawaii face in idle status bar
- Theme-aware emoji gating in status bar

### Sprint 5 — Catalog ramp (2 weeks)
- 30 first-party skills authored
- ClawHub importer + security scanner
- Featured skill rotation logic
- Top 5 workflows shipped

### Sprint 6 — Code refactor + Plugin sandbox (2 weeks)
- Split main.js into ipc/*.js
- Plugin sandbox via vm context
- Real ctx.fetch/logger/storage in plugin runtime
- Tool registry consolidation

### Sprint 7 — Distribution + Multi-agent (3 weeks)
- npm i -g @horizonai/cli published
- Homebrew tap, scoop bucket
- Durable Kanban runtime
- SQLite-first memory flip (Sprint 7B: DONE — JSON is now export-only,
  legacy memory.json auto-migrates into memory.sqlite on first boot
  and archives as memory.json.legacy.<ts>; opt back via
  HORIZON_MEMORY_BACKEND=json)

---

**Source agent reports stored in transcript at:**
`C:\Users\ernes\.claude\projects\D--Genesis\*.jsonl`

**Cited Hermes URLs:**
- https://hermes-agent.nousresearch.com/docs
- https://github.com/NousResearch/hermes-agent
- https://github.com/NousResearch/hermes-agent/releases/tag/v2026.5.16
- https://agentskills.io
- https://www.hermeshub.xyz
- https://clawhub.ai
- https://github.com/VoltAgent/awesome-openclaw-skills
- https://github.com/anthropics/skills
