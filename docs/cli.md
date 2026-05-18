# Horizon CLI + TUI + HTTP API

Single Node.js entry point that exposes the full Horizon agent stack — same
memory, skills, personas, executor, and connections as the Electron GUI —
to terminals, scripts, cron jobs, and remote clients. No Electron window,
no main process boot, no IPC. Just the runtime.

Reads from and writes to the **same** settings/keys/memory/skills files
the Electron app uses (`%APPDATA%/horizon-ai/` on Windows,
`~/Library/Application Support/horizon-ai/` on macOS,
`~/.config/horizon-ai/` on Linux). Set up your provider keys once in the
GUI; the CLI sees them immediately.

## Install

The binaries ship with the Electron app — `npm install` from the repo root
also wires up `horizon`, `horizon-tui`, and `horizon-serve` under
`node_modules/.bin/`. To call them globally from anywhere:

```bash
npm link            # symlinks horizon → bin/horizon.js
horizon version     # ← any directory now
```

Or invoke directly:

```bash
node bin/horizon.js version
npm run cli -- version           # same thing
```

## Quick start

```bash
horizon version                      # show paths, keys, memory, skills
horizon "найди все TODO в проекте"   # shorthand for `horizon agent "..."`
horizon chat "what's the weather?"   # single-turn chat
horizon                              # launch the TUI
horizon serve --port 18789           # boot the headless HTTP API
```

## Commands

### `horizon`
No-args → launches the TUI (`horizon-tui.js`).

### `horizon "task"` / `horizon agent "task"`
Full agent loop with tool use + reflection. Streams steps to stdout.

```bash
horizon agent "refactor src/auth.js to async/await"
horizon agent "list packages with security advisories" --auto-approve
horizon agent "summarise yesterday's commits" --provider claude
horizon agent "do thing" --max-steps 12 --no-reflect --json
```

Flags:
- `--json` / `--human` / `--quiet` — output format (default: human in TTY,
  json when piped)
- `--max-steps N` — cap loop iterations (default 8)
- `--no-reflect` — skip the reflection epilogue
- `--auto-approve` / `--never-approve` — permission gate strategy
- `--provider X` / `--model X` / `--persona X` — override for this run
- `--workspace path` — override `.horizon/` lookup root

When piped (non-TTY), output defaults to NDJSON — one JSON event per line.
Last line has `type: 'run-end'` with the final `{ok, answer, steps, error}`.

### `horizon chat "message"`
Single-turn chat. No agent loop, no tools, no plan. Prints reply to stdout.

```bash
horizon chat "summarise this:" --quiet < article.txt
horizon chat "what's the capital of Lithuania?" --json | jq .reply
```

### `horizon skill <subcommand>`
Manage SKILL.md bundles (workspace / user / builtin scopes).

```bash
horizon skill list                       # all skills, grouped by scope
horizon skill list --scope user          # filter to one scope
horizon skill list --json                # machine-readable
horizon skill show refactor-react        # print SKILL.md contents
horizon skill new my-skill --scope user  # scaffold a new skill
horizon skill enable bug-report          # toggle
horizon skill disable bug-report
horizon skill run refactor-react "task"  # bias the next agent run
```

### `horizon mem <subcommand>`
Memory operations.

```bash
horizon mem search "yerba mate" --limit 5     # hybrid recall (semantic+FTS+kw)
horizon mem search "..." --no-semantic        # keyword-only
horizon mem dump --type facts > facts.jsonl   # export NDJSON
horizon mem dump --type memories
horizon mem dump --type conversations
horizon mem dump                              # all
horizon mem profile                           # user profile (Big Five etc.)
horizon mem forget --memory <id>              # delete one memory
horizon mem forget --fact <key>               # delete one fact
horizon mem stats                             # counts + embedding state
```

### `horizon model [provider] [--model X] [--list]`
Read or set the active provider/model.

```bash
horizon model                                  # print current
horizon model --list                           # all providers + key health
horizon model claude                           # switch provider
horizon model openai --model gpt-5.4-mini      # provider + per-provider model
```

### `horizon persona [id] [--list]`
Read or set the active persona.

```bash
horizon persona                                # print current
horizon persona --list                         # all options
horizon persona alfred                         # switch
```

### `horizon connect <subcommand>`
Configure messaging channels.

```bash
horizon connect list                                # all channels + status
horizon connect test telegram_bot                   # ping
horizon connect telegram --token <bot-token>        # save Telegram bot token
horizon connect discord  --token <bot-token>        # save Discord bot token
horizon connect slack    --token xoxb-...           # save Slack token
horizon connect notion   --token secret_...         # save Notion token
horizon connect linear   --token lin_api_...        # save Linear key
```

The CLI saves the token to the encrypted `horizon-keys.json` file. To
actually run the Telegram/Discord listener loop, use the GUI or
`horizon serve --enable-tg / --enable-discord`.

### `horizon serve [--port N] [--token X]`
Headless HTTP API. Lets PWAs, cron jobs, mobile clients, or another
machine on your LAN drive the agent over JSON + Server-Sent Events.

```bash
horizon serve --port 18789 --token mysecret
horizon serve --enable-tg --enable-discord          # also start live bots
```

Endpoints (all require `Authorization: Bearer <token>`):

| Method | Path                | Description                                     |
|--------|---------------------|-------------------------------------------------|
| GET    | `/api/health`       | Liveness ping                                   |
| GET    | `/api/version`      | Runtime info, memory counts, provider, keys     |
| GET    | `/api/skills`       | List of skills (full metadata)                  |
| GET    | `/api/personas`     | List of personas                                |
| GET    | `/api/mem/profile`  | User Profile (Big Five + style + preferences)   |
| POST   | `/api/chat`         | Body `{message, history?, provider?, ...}` → JSON reply |
| POST   | `/api/agent`        | Body `{task, history?, max_steps?, reflect?, ...}` → JSON result (or SSE stream if `Accept: text/event-stream`) |
| POST   | `/api/mem/search`   | Body `{query, limit?, semantic?}` → results     |
| POST   | `/api/mem/forget`   | Body `{memory?|fact?}` → ok                     |
| POST   | `/api/model`        | Body `{provider, model?}` → ok                  |
| POST   | `/api/persona`      | Body `{id}` → ok                                |

SSE streaming example:

```bash
curl -sN -H "Authorization: Bearer mysecret" \
        -H "Accept: text/event-stream" \
        -H "Content-Type: application/json" \
        -d '{"task":"summarise repo","provider":"groq"}' \
        http://127.0.0.1:18789/api/agent
```

→ emits `event: step\ndata: {...}\n\n` for each loop event, then a final
`event: end\ndata: {ok, answer, steps, stopped, error}`.

If `--token` is omitted and `HORIZON_TOKEN` is unset, the server generates
a random 32-char hex token at startup and prints it to stderr.

### `horizon tui`
Interactive shell — same as bare `horizon` with no args.

Slash commands inside the TUI:

```
/help                show command list
/quit                exit
/clear               clear the screen
/reset               clear chat history (memory keeps everything)
/skills              list installed skills
/skill <id> [task]   force-include a skill in the next turn
/skill-show <id>     print a skill's SKILL.md
/persona             show active persona
/persona <id>        switch persona
/persona-list        list all personas
/model               show active provider/model
/model <provider>    switch provider
/model-list          list all providers + key health
/mem "query"         semantic memory search
/agent <task>        force-run the full agent loop
/chat <message>      force single-turn chat
```

Plain text typed at the `›` prompt runs in the current mode (defaults to
chat; `/agent <task>` flips to agent mode for that one turn).

### `horizon version`
Print version, paths, active provider/model/persona, key health,
memory counts, skill count, embedding state, and executor backend.

```bash
horizon version           # human-formatted
horizon version --json    # machine-readable
```

## Permission gate

For destructive-ish tools (`run_code`, `run_shell`, `write_file`,
`delete_file`, `mouse_click`, all `conn_*_send/post/create/append`, etc.)
the CLI prompts:

```
⚠ approve run_code {"language":"python","code":"..."}? (Python: '...')
  y/N:
```

Override with:

- `--auto-approve` — say yes to everything (cron-safe but dangerous)
- `--never-approve` — read-only mode; declines all gated tools
- default — prompt interactively

Read-only tools (`read_file`, `list_dir`, `recall`, `web_search`, etc.)
never prompt.

## File locations

| File                                      | What it stores                                              |
|-------------------------------------------|-------------------------------------------------------------|
| `<userData>/horizon-settings.json`        | provider, model, persona, lang, all preferences             |
| `<userData>/horizon-keys.json`            | encrypted API keys (AES-256-GCM, machine-id derived key)    |
| `<userData>/horizon_memory.json`          | 8-type memory (facts, memories, conversations, profile…)    |
| `<userData>/horizon_chats.json`           | multi-chat history (Electron-only; CLI keeps in-memory)     |
| `<userData>/skills/<id>/SKILL.md`         | user-scope installed skills                                 |
| `<userData>/plugins/<id>/`                | user-scope installed plugins                                |
| `<workspace>/.horizon/memory.json`        | workspace-bound memory (committed in git)                   |
| `<workspace>/.horizon/skills/<id>/`       | workspace-scoped skills (committed in git)                  |
| `<workspace>/.horizon/rules.md`           | workspace rules (injected into every system prompt)         |
| `<repo>/builtin-skills/<id>/SKILL.md`     | ships-with-Horizon skills                                   |

`<userData>` resolves to:

- Windows: `%APPDATA%/horizon-ai/`
- macOS:   `~/Library/Application Support/horizon-ai/`
- Linux:   `~/.config/horizon-ai/`

## Output format

| Pattern    | Default        | Override with     |
|------------|----------------|--------------------|
| Interactive terminal | human-formatted | `--json`, `--quiet` |
| Piped to a file/another command | NDJSON | `--human`, `--quiet` |

For agent runs, NDJSON contains one event per line:

```
{"type":"plan","plan":{"steps":[...]}}
{"type":"thinking","step":1,"phase":"deliberate"}
{"type":"waiting","tool":"run_code","args":{...},"reason":"..."}
{"type":"executing","tool":"run_code","args":{...}}
{"type":"result","tool":"run_code","ok":true,"result":{...}}
{"type":"reflection","goalMet":"yes","confidence":0.9}
{"type":"run-end","ok":true,"answer":"...","steps":3}
```

## What's not in the CLI yet

- **MCP servers** — the Electron app discovers + spawns MCP stdio servers
  via the IPC layer. CLI version is on the roadmap (Phase 6).
- **Computer-use vision** — `screen_capture`, `smart_click`, etc. work
  but need the desktop environment to be reachable; over plain SSH they
  no-op gracefully.
- **Playwright `browserManager`** — opt-in via a future `--with-browser`
  flag (Phase 6).
- **Workflows engine** — opt-in via a future `--with-workflows` flag.
- **Live skill suggester** — no banner without a renderer.
- **TUI streaming token-by-token** — current implementation prints the
  reply at end-of-turn. Phase 4 polish.

## Use cases

### Cron-driven check

```cron
0 9 * * 1-5  horizon agent "check disk space; alert via slack if <10GB free" --auto-approve --quiet
```

### Mobile companion (PWA via serve)

1. `horizon serve --token mysecret` on your desktop
2. PWA hits `http://<your-LAN-IP>:18789/api/agent` with the bearer token
3. SSE streams the run; PWA renders each step

### Headless VPS

```bash
ssh server
git clone https://github.com/ErnestKostevich/horizon-genesis
cd horizon-genesis
npm ci
node bin/horizon.js model gemini --model gemini-2.5-flash
# put your Gemini key in horizon-keys.json (use horizon connect or edit by hand)
node bin/horizon.js agent "monitor /var/log/syslog for OOM kills"
```

### Pipe into other tools

```bash
horizon chat "convert this CSV header to TypeScript interface:" --quiet < headers.csv > types.ts
horizon mem dump --type facts | jq 'select(.key | startswith("project."))'
horizon agent "find duplicate functions" --json | jq 'select(.type=="result")'
```
