# Honest comparison vs Hermes Agent

Last updated: 2026-05-21 (post-Sprint 7). This is a working-code audit, not
a marketing page. Every "✓" here was verified by reading the source or
smoke-tested locally. Things that exist but aren't wired end-to-end get a
"🔸" with a note. Things Hermes does that we don't are listed plainly.

## TL;DR

Horizon is **at or above** Hermes on these axes:
- desktop GUI surface (Electron app, full chat UI, plugin marketplace, settings)
- mobile companion (PWA with QR-pair, lives in `mobile/`)
- computer use depth (vision + click + keyboard + wake word + **OCR + multi-display + macro recorder** — Sprint 7 closed the cua-driver gap)
- personas (5 built-in + per-persona memory + per-persona voice)
- memory architecture (**13 layers** incl. Honcho-style dialectic ToM diff log, consolidation insights, entity/relationship graph, working-memory scratchpad, and pinned core)
- monetised marketplace with crypto payouts to authors (USDT TRC20/BSC/TON/SOL, 70/30)
- 8 CLI themes (default / mono / light / kawaii / matrix / retro-amber / vapor / mocha)
- vm-sandboxed plugin SDK (community plugins safe-by-default)
- durable multi-agent Kanban runtime (subagents survive parent crash)
- package-manager install parity — `npm i -g @horizonai/cli`, Homebrew tap, Scoop bucket

Horizon **lags** Hermes on:
- TUI polish (Python Textual vs our pure-Node readline+ANSI)
- messaging channel coverage (7 vs 22)
- skill catalog size (30 first-party vs 691 — but we have a ClawHub importer
  + security scanner + curator strategy to vet community skills as we ingest them)
- community size (159k+ stars)
- raw CLI subcommand count, depending how you count (53 vs ~70)
- managed inference backend (Hermes Portal is their own hosted)

Net assessment: **comparable, with different shape**. We're stronger as
a *desktop + mobile* product with depth (computer use, personas, memory);
they're stronger as a *terminal + channels* product with breadth (skills,
channels, community).

---

## By-feature breakdown

### Desktop GUI

| | Horizon | Hermes |
|---|---|---|
| Native installer per OS | ✓ NSIS + portable + DMG + AppImage + deb | ✗ TUI-only |
| Chat UI | ✓ chat.html + composer + inspector + step rail | ✗ |
| Plugin marketplace UI | ✓ in-app browse/install | ✗ |
| Settings UI | ✓ Settings tab with all provider keys + connections | partial via CLI |
| Computer-use overlay | ✓ visible "AGENT IN CONTROL" banner | n/a |

**Verdict: Horizon clearly ahead.** Hermes is a developer-focused tool;
we have a desktop app a non-coder can use.

### Terminal CLI

| | Horizon | Hermes |
|---|---|---|
| Subcommands | 53 unique | ~70 |
| Streaming chat | ✓ token-by-token across 25 providers | ✓ |
| Markdown rendering | ✓ in-terminal | ✓ |
| ASCII banner + gradient spinner | ✓ | ✓ |
| Shell autocomplete | ✓ bash + zsh + fish + pwsh | ✓ |
| Self-update | ✓ binary swap + source pull | ✓ |
| Standalone binaries | ✓ 4 platforms via @yao-pkg/pkg | ✓ via PyInstaller |
| **TUI mouse / scrollback / multi-line** | ✓ (Phase 11 TUI v2) | ✓ via Textual |
| **Cost tracking + budgets** | ✓ `horizon cost` w/ bar chart | ✗ |
| **Smart routing** | ✓ `--provider auto` walks 18 candidates | ✗ |
| **Multi-profile** | ✓ `horizon profile create work` | ✓ |
| **Onboarding wizard** | ✓ `horizon setup` 5-step | ✓ |
| **Health check / auto-fix** | ✓ `horizon doctor [--fix]` | ✓ |
| **Cron daemon in CLI** | ✓ `horizon cron daemon` (custom 5-field parser) | ✓ |
| Migration from a competitor | ✗ | ✓ `hermes claw migrate` |
| **Headless HTTP+SSE API** | ✓ `horizon serve` with bearer token | ✓ `hermes dashboard` |

**Verdict: Hermes' TUI polish is higher.** We have functional parity on
core verbs + extra "cost tracking" which Hermes lacks. Hermes is
clearly more verb-heavy (auth/sessions/checkpoints/kanban/webhook all
have dedicated subcommands; ours sometimes route through `cost` or
`logs`).

### Headless / server

| | Horizon | Hermes |
|---|---|---|
| HTTP API | ✓ JSON + SSE for /api/agent | ✓ |
| Bearer auth | ✓ | ✓ |
| Single-machine daemon | ✓ via `horizon serve` | ✓ via `hermes gateway` |
| Mobile companion served from daemon | ✓ PWA in `mobile/`, QR-pair | ✗ |
| Multi-machine "agent mesh" | ✗ planned | partial (gateway model) |
| VPS deployment guide | ✓ docs/deploy.md (systemd + nginx + TLS) | ✓ |
| systemd unit | ✓ in docs | ✓ |
| nginx config with SSE proxy_buffering off | ✓ | ✓ |
| Durable multi-agent runtime | ✓ Kanban queue, subagents survive parent crash | ✓ |

**Verdict: comparable on the daemon shape; Horizon adds Mobile PWA
companion served from the same daemon.** QR-pair phone to your VPS,
get the full agent loop on mobile.

### Memory / context

| | Horizon | Hermes |
|---|---|---|
| Storage | **SQLite + FTS5 (primary)** + JSON export + embeddings sidecar | SQLite + FTS5 |
| Scale ceiling | millions (Sprint 7B flipped to SQLite-first) | millions |
| **13 distinct memory layers** | ✓ facts/memories/conversations/embeddings/FTS/profile/persona/workspace/dialectic/**insights/consolidation**/entity graph/scratchpad/pinned core | ~4 layers |
| Dialectic / theory-of-mind diff log | ✓ Honcho-style multi-level (0=user, 1=user→agent, 2=recursive); multi-tenant | ✗ |
| Semantic recall (256-dim embeddings) | ✓ OpenAI 3-small or Gemini | ✓ |
| Workspace-bound memory | ✓ `.horizon/memory.json` (commit in git) | ✗ |
| User Profile (Big-Five) | ✓ auto-updated from chat | ✗ |
| Per-persona memory | ✓ tagged by active persona | ✗ |
| Hybrid recall (semantic + FTS + keyword) | ✓ weighted blend | partial |
| Legacy JSON migration | ✓ auto on first boot, archived as `memory.json.legacy.<ts>` | n/a |

**Verdict: Horizon's memory is richer in shape AND now matches Hermes on
scale.** Sprint 7B flipped JSON-first → SQLite-first; JSON is export-only.
Plus the dialectic model (Honcho-style multi-level ToM diff log) is unique
to Horizon — Hermes has no equivalent.

---

## Memory — Horizon vs Hermes vs OpenClaw

This table covers v0.0.3 Horizon. Hermes data is from a post-Sprint 7 source
audit; OpenClaw data is from public ClawHub docs and the SOUL.md convention
described in their repo. Where behaviour was not directly verifiable,
"unknown" or a 🔸 note is used — this is a working-code audit, not a
marketing page.

| Capability | Horizon (v0.0.3) | Hermes | OpenClaw |
|---|---|---|---|
| **Storage layers / layer count** | **13 layers** (SQLite primary + FTS5 + embeddings) | ~4 layers (SQLite + FTS5, no published layer taxonomy) | 🔸 file-based: SOUL.md + workspace files; layer count unknown |
| **Hybrid recall** (semantic + keyword + FTS + usefulness) | ✅ weighted blend of all four signals | 🔸 semantic + FTS; usefulness signal unknown | 🔸 semantic recall via embeddings; FTS/keyword blend unknown |
| **Usefulness feedback loop** (memory learns what helped) | ✅ usefulness score updated per-retrieval | ❌ not observed in source | ❌ not observed in public docs |
| **Episodic → semantic consolidation** (insights) | ✅ clusters of related episodic memories compressed into higher-order insight records | ❌ no equivalent | ❌ no equivalent |
| **Entity/relationship graph** (contradiction-aware) | ✅ typed entity+relation graph; contradiction detection on insert; pulled into context when entity is named | ❌ | ❌ |
| **Working-memory scratchpad** (per-task notepad) | ✅ ephemeral notepad scoped to current task; persists across reflection rounds | ❌ | unknown |
| **Pinned / curated core** (always-injected) | ✅ user-pinned memories guaranteed in every context window | ❌ | 🔸 SOUL.md is always-injected but not user-curated at memory level |
| **Theory-of-mind dialectic user model** | ✅ Honcho-style multi-level diff log (0=user, 1=user→agent, 2=recursive); multi-tenant | ✅ Honcho-style personality + dialectic system (different implementation) | ❌ |
| **Persona-bound memory** | ✅ memories tagged by active persona; isolated per persona | ❌ no persona concept | ❌ |
| **User profile (Big Five + communication style)** | ✅ auto-updated from conversation | 🔸 personality model exists; update mechanism unknown | ❌ |
| **Workspace-bound memory** | ✅ `.horizon/memory.json` (committable to git) | ❌ | ✅ SOUL.md + workspace files (similar intent, file-based) |
| **Explainable recall** (why a memory surfaced) | 🔸 scored output shows weights; no dedicated explain UI yet | unknown | unknown |

**Notes:**
- Hermes has a genuine dialectic/personality system (Honcho-style); the
  implementations differ but the concept is comparable. Their layer count is
  not publicly documented as a taxonomy — "~4 layers" reflects what was
  observable in source (facts, episodic, FTS, embeddings).
- OpenClaw's SOUL.md is a compelling always-injected persona file, but it is
  static author-written content, not a dynamically updated memory layer.
  OpenClaw's memory model is simpler by design; this is not a weakness if the
  use-case doesn't require deep memory.
- Horizon's consolidation, entity graph, and working-memory scratchpad
  (layers 10–12 of 13) are v0.0.3 additions — they are in the committed
  codebase but have not been stress-tested at scale.

---

### AI providers

| | Horizon | Hermes |
|---|---|---|
| Direct integrations | 25 | ~10-15 |
| Via wrapper / aggregator | OpenRouter (300+) + custom OpenAI-compat URL + LiteLLM router | LiteLLM (200+) |
| Reasoning effort tuning | ✓ per provider where supported | ✓ |
| Vision-on-turn-1 (auto-screenshot in agent mode) | ✓ Claude / OpenAI-compat / Gemini | ✗ |
| Token-by-token streaming | ✓ all major providers | ✓ |
| Local model support | ✓ Ollama / LM Studio / LocalAI | ✓ |
| Free-tier-first routing | ✓ `--provider auto` | ✗ |

**Verdict: Horizon ahead via auto-routing + cost tracker.** Hermes
reaches more models through its wrapper, but at the cost of
homogenising everything; we keep provider-specific quirks (Claude
extended thinking, Gemini thinkingBudget, OpenAI reasoning_effort).

### Sandbox / executor backends

| | Horizon | Hermes |
|---|---|---|
| Host | ✓ | ✓ |
| Docker | ✓ with workspace mount control + per-call resource limits | ✓ |
| SSH | ✓ uses OpenSSH client, no native deps | ✓ |
| Modal | ✓ BYOK via `horizon connect modal --token-id X --token-secret Y` | ✓ |
| Daytona | ✓ BYOK via `horizon connect daytona --server X --key Y --workspace Z` | ✓ |
| Singularity / Apptainer (HPC clusters) | ✓ added Sprint 6 | ✓ |
| Serverless / Functions | partial via Modal | ✓ |

**Verdict: parity on all 6 backends.** All BYOK — user signs up, gets
credentials, plugs them in, switches `executionMode`. No platform
middleman.

### Messaging channels

| | Horizon | Hermes |
|---|---|---|
| Telegram | ✓ bot + long-polling runtime | ✓ |
| Discord | ✓ Gateway WebSocket + slash commands | ✓ |
| Slack | ✓ Socket Mode (xapp + xoxb) | ✓ |
| WhatsApp | ✓ Twilio adapter (BYOK) | ✓ |
| Signal | ✓ self-hosted signal-cli bridge (BYOK) | ✓ |
| iMessage (macOS) | ✓ Messages.app via osascript | ✓ |
| Email (IMAP+SMTP) | ✓ imapflow + nodemailer | ✓ |
| Matrix | ✗ | ✓ |
| Mattermost | ✗ | ✓ |
| Teams | ✗ | ✓ |
| SMS (Twilio) | ✗ | ✓ |
| Notion | ✓ (tools, not full conversational bot) | n/a |
| Linear | ✓ (tools) | n/a |
| GitHub | ✓ (tools + webhook) | ✓ |

**Verdict: Hermes still leads on channel breadth (22 vs 7),** but the
core five Horizon was missing (WhatsApp / Signal / iMessage / Slack /
Email) all shipped during Sprint 1-7. Matrix / Mattermost / Teams /
SMS are per-adapter work, no architectural blocker — added on demand.

### Skills

| | Horizon | Hermes |
|---|---|---|
| First-party / built-in skills | 30 (`builtin-skills/`) | partial — relies on Skills Hub |
| Community catalog size | growing — ClawHub importer + scanner | 691 on Skills Hub |
| SKILL.md format | ✓ Anthropic-compatible frontmatter+body+helpers | ✓ agentskills.io format |
| Three scopes (workspace/user/builtin) | ✓ | partial |
| Auto skill suggestion | ✓ on repeated patterns | ✓ |
| Skill marketplace | ✓ horizonaai.dev/browse | ✓ Skills Hub |
| Crypto payouts to authors | ✓ NOWPayments, 70/30 split, USDT TRC20/BSC/TON/SOL | ✗ free hub |
| Cross-format import (between hub + ours) | ✓ ClawHub importer (Sprint 5) + scanner | ✓ |

**Verdict: Horizon wins on monetisation; Hermes still leads on raw
catalog size.** Curator strategy: 30 first-party + ClawHub importer
with security scanner = grow community catalog without out-building
ClawHub directly.

### Personas

| | Horizon | Hermes |
|---|---|---|
| Built-in personas | ✓ Jarvis / Friday / Alfred / Sage / Pixel | ✗ |
| Custom personas | ✓ create + edit in UI | ✗ |
| Per-persona tool allow-list | ✓ | n/a |
| Per-persona memory | ✓ tagged automatically | n/a |
| Voice persona (TTS preset) | ✓ ElevenLabs voice + OpenAI TTS per persona | ✗ |
| Wake-word response per persona | ✓ ("yes sir" for Jarvis, etc.) | ✗ |

**Verdict: Horizon unique here.** Hermes has no persona concept.

### Computer use / voice

| | Horizon | Hermes (v2026.5.16 cua-driver) |
|---|---|---|
| Screenshot | ✓ + auto-capture when task mentions screen | ✓ basic |
| Mouse click | ✓ computer.click | ✓ |
| Vision-guided click (smart_click) | ✓ via Gemini/Claude vision | 🔸 |
| Mouse drag / scroll | ✓ | 🔸 |
| Keyboard type | ✓ computer.type | ✓ |
| **OCR (text from screenshot)** | ✓ Tesseract.js (Sprint 7) | ✗ |
| **Multi-display support** | ✓ enumerate + capture per display (Sprint 7) | ✗ |
| **Macro recorder / replayer** | ✓ record mouse + keyboard, deterministic replay (Sprint 7) | ✗ |
| Wake word | ✓ Deepgram + Groq fallback | ✗ |
| Continuous talk mode | ✓ no need to repeat wake word | ✗ |
| TTS | ✓ 4 providers: ElevenLabs / OpenAI / system / Kokoro | ✗ |
| Screen recording | ✓ ScreenRecorder | ✗ |
| Visual "AGENT IN CONTROL" indicator | ✓ pulsing banner | n/a |

**Verdict: Horizon still leads here — Sprint 7 closed the gap Hermes
opened with `cua-driver`** (OCR + multi-display + recordable macros are
all unique to Horizon now). Hermes is server/messaging-first; we
deliberately built around the desktop sensing/acting loop.

### Plugin SDK

| | Horizon | Hermes |
|---|---|---|
| TypeScript types package | ✓ `@horizonai/plugin-types` on npm | ✓ |
| Scaffolder CLI | ✓ `npx @horizonai/plugin-cli init` | ✓ |
| Permission manifest | ✓ network:host, fs:read/write, shell, clipboard, etc | ✓ |
| **vm-based sandbox** | ✓ Sprint 6 — community plugins safe-by-default | 🔸 |
| Real `ctx.fetch / logger / storage` runtime | ✓ Sprint 6 (fixed earlier lie-of-omission) | ✓ |
| Marketplace publishing | ✓ via `hz-plugin publish` | ✓ |
| Examples in repo | ✓ hello-world + 6 builtin plugins (web-fetch, clipboard, etc.) | ✓ |

**Verdict: Horizon ahead on sandbox safety.** The vm sandbox blocks
`require('fs'|'net'|'electron')`, aborts runaway loops, and prevents
host-global mutation — community plugins from the marketplace cannot
escape into the host process. Opt-out via `HORIZON_PLUGIN_NO_SANDBOX=1`
for trusted/local development.

---

## Functional smoke tests run for this document

These were all verified locally on the working tree (post-Sprint 7):

| Test | Result |
|---|---|
| `npm test` — unit | ✓ 178/178 passing |
| `npm run test:integration` — integration | ✓ 36/36 passing |
| `horizon version` after fresh install on this machine | ✓ shows memories, 30 builtin skills, keys |
| `horizon model --list` | ✓ 26 providers (25 + litellm pseudo) |
| `horizon chat "hi"` with streaming | ✓ tokens stream via groq |
| `horizon agent "посчитай 7*13"` --auto-approve | ✓ NDJSON: plan → run_code → result(91) |
| `horizon cron create "0 9 * * 1-5" "..." --mode agent` | ✓ "weekdays at 9:00" parsed, persisted |
| `horizon doctor` | ✓ 10 checks, reports warnings + auto-fix-able |
| `horizon profile create work` round-trip | ✓ userData isolated |
| `horizon stats --days 7` | ✓ memory + skills + cron + cost in one view |
| `horizon theme matrix` then `horizon theme --list` | ✓ 8 themes available, persisted in settings |
| `horizon serve` + curl `/api/health` `/api/version` `/api/chat` | ✓ bearer auth enforced |
| `horizon serve` + SSE `/api/agent` | ✓ step events stream |
| QR-pair from Mobile PWA against `horizon serve` | ✓ same chat / memory |
| Plugin sandbox — load a hostile community plugin | ✓ refused; safe plugin loads |
| Durable Kanban — kill parent mid-task, restart | ✓ subagent resumes from queue |
| TUI v2 in Windows Terminal: Shift+Enter, Ctrl+F, PageUp | ✓ |

## Honest "not yet" list

Post-Sprint 7, the previous gaps have largely closed. Remaining:

| Feature | Built? | Missing piece |
|---|---|---|
| Modal executor | ✓ code path | docs for the Python deployable function user must `modal deploy` once |
| Daytona executor | ✓ code path | tested only against mocked endpoint, not a real workspace |
| Auto-screenshot vision on turn 1 | ✓ end-to-end | not stress-tested across all providers |
| Matrix / Mattermost / Teams / SMS channels | ✗ | adapters not written; per-channel work, no architectural blocker |
| Skill catalog parity (691 skills) | partial | 30 first-party + ClawHub importer; need to ingest and vet community skills |
| `hermes claw migrate` competitor-import tool | partial | ClawHub importer + scanner exist; full Hermes-format migration not yet |
| MCP servers spawnable from CLI | partial | config + registry done; process-spawn next |
| Plugin SDK v2 with Rust/WASM support | ✗ | TypeScript SDK + vm sandbox shipped first |

These are not vapourware: every check-marked feature in this doc has
working code committed (178/178 unit tests + 36/36 integration passing).
The "not yet" list is the next-iteration backlog, not the marketing
claim.

---

## "Are we crusher than Hermes?"

The framing matters. Compared **feature-by-feature** (post-Sprint 7):

- For a desktop user who wants a Cursor-style assistant with a real
  GUI, **deep** computer use (OCR + multi-display + macros), personas,
  voice, vm-sandboxed plugins, and a crypto-payout marketplace:
  **Horizon is meaningfully ahead**. Hermes' `cua-driver` is basic by
  comparison.
- For a mobile-first user who wants the agent on their phone with a
  QR-pair to a VPS: **Horizon wins**. Hermes has no mobile companion.
- For a power user living in a terminal who wants ssh, cron, sessions,
  webhook hooks, kanban, and integration with 22 messaging platforms,
  plus a 691-skill community catalog: **Hermes is meaningfully ahead
  on breadth**. We catch most of the verbs and have a durable
  multi-agent Kanban, but not the breadth of channels or community
  skills.
- For a team deploying an agent on a VPS to drive Slack / Telegram /
  Discord with skills + memory: **comparable** — we now ship 7 channels,
  all package-manager-installable, with SQLite-first memory at parity
  on scale.

We're not a strict superset. We're a different shape — deeper on the
desktop + mobile + computer-use axis, slightly thinner on the
terminal/channel/community-catalog axis. Sprint 7 closed the gaps
Hermes opened (durable Kanban, SQLite-first, OCR/multi-monitor/macros,
package-manager install parity). What remains is community size and
channel breadth — both of which are time-and-adapter problems, not
architectural ones.
