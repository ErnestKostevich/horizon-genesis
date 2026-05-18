# Horizon Memory Architecture — 8 Types

Horizon's long-term memory is layered. Each type answers a different
question; together they let Horizon learn, remember context, and adapt
to the user without one big amorphous "memory" blob that becomes
useless after a few weeks.

> Status: types 1–5 are live. Types 6–8 are designed here and scheduled
> for the next memory sprint.

| # | Type | Purpose | Where | Status |
|---|---|---|---|---|
| 1 | **Facts** | Stable key-value preferences ("user.name = Ernest") | `_data.facts` | ✅ live |
| 2 | **Memories (episodic)** | Timestamped observations with category & importance | `_data.memories[]` (cap 2000) | ✅ live |
| 3 | **Conversations** | Full chat transcripts, searchable | `_data.conversations[]` (cap 500) | ✅ live |
| 4 | **Semantic index** | Embedding vectors + cosine recall | `horizon_embeddings.json` (sidecar) | ✅ live |
| 5 | **User Profile** | Big Five + communication style + goals | `_data.userProfile` | ✅ live (manual edit; auto-update planned) |
| 6 | **FTS Index** | Real SQLite FTS5 over memories + conversations | `horizon_fts.db` (new) | 🟡 planned |
| 7 | **Persona Memory** | Persona-bound overlay (Jarvis vs Friday remembers differently) | `_data.personaMemory{personaId}` | 🟡 planned |
| 8 | **Workspace Conventions** | Team-shareable project memory | `.horizon/memory.json` (committable) | 🟡 planned |

---

## Cross-cutting: Memory Provenance

Every memory write knows where it came from. Field: `source` on the
record, `lastSource` updated on each touch. Set automatically by the
write path (chat, telegram, agent task, learnFromTurn, tool, manual,
profile). Surfaces in the Learned tab as a coloured badge so the user
can filter "what did Telegram teach Horizon" vs "what did I tell it
manually".

Values (`MEMORY_SOURCES` in `src/main/agent.js`):

- `chat` — desktop chat input
- `agent_task` / `agent_result` — agent loop write-backs
- `telegram` / `slack` / `discord` — channel adapters
- `tool` — remember/set_fact tool dispatch by the model
- `learn` — `learnFromTurn` regex extraction
- `profile` — user profile edit
- `manual` — direct Inspector → Learned edit
- `import` — bulk migration / Trust Ledger replay

---

## Type 1 — Facts (live)

Flat key-value. Each entry: `{ value, updated, seen, source, lastSource }`.
Keys are normalised lower-trim'd strings ≤120 chars; values ≤1200 chars.
`seen` increments when the same value is reaffirmed (e.g. the user says
their name multiple times); manual edits via Inspector → Learned add or
overwrite.

**Use it for:** persistent identity (user.name, project.name), tonal
preferences (always_use_metric), API/tool defaults.

**Don't use it for:** anything timestamped or with context — those go
into Memories (#2). Don't use for free-form prose — fact values stay
short.

---

## Type 2 — Memories / Episodic (live)

Append-only timeline of observations. Schema:

```ts
{
  id: number,          // Date.now() at creation
  key: string,         // dedup hash (category:hash12)
  category: string,    // grouping label — 'learned_preference', 'project_context', etc.
  content: string,     // ≤1200 chars
  created: number, lastSeen: number,
  seen: number,        // how many times the same key was re-asserted
  importance: 1..10,
  source: string,      // initial source
  lastSource: string,  // most recent source
}
```

Capped at 2000 entries (oldest dropped, embeddings sidecar pruned in
sync). Edit/forget via Inspector → Learned.

**Use it for:** "user said in October they prefer dark mode", "agent
finished kubernetes task at 14:32", "Telegram chat referenced project
Acme".

**Recall:** `recall(query, limit)` (sync keyword) or `semanticRecall`
(embedding-blended). See type 4.

---

## Type 3 — Conversations (live)

Full transcripts. Each entry has `{ id, user, assistant, meta, source,
time }`. Cap 500, no trimming of body text within entry. Source set by
the caller (chat / telegram / agent runtime / etc.).

**Use it for:** "what did we discuss last week about the deploy
script?" — searchConversations() returns keyword-scored matches with
context.

**Don't use it for:** atomic facts (#1) or compressed memories (#2).
Conversations are append-only history; if the user retells a fact,
that fact goes into #1.

---

## Type 4 — Semantic Index (live)

256-dim embedding vectors (OpenAI `text-embedding-3-small` or Gemini
`text-embedding-004`). Sidecar file separate from the main memory JSON
so the human-readable memory file stays small. Indexed key = memory
key (#2).

**Recall:** cosine-similarity vs query embedding. `semanticRecall`
blends 0.6 × semantic + 0.4 × keyword and filters at sem ≥ 0.18.
Falls back to pure keyword when no embedding key is configured.

**Reindex UI:** Inspector → Learned → "Reindex now" runs
`memEmbedReindex`. Backend uses Gemini's `batchEmbedContents` endpoint
for speed.

---

## Type 5 — User Profile (live)

Honcho-inspired structured user model. Schema:

```ts
{
  bigFive: {
    openness, conscientiousness, extraversion, agreeableness, neuroticism  // 0..1
  },
  communicationStyle: {
    formality: 'casual' | 'mixed' | 'professional',
    verbosity: 'brief' | 'medium' | 'verbose',
    preferredAddress: string,  // e.g. "Сэр", "boss", first name
    lang: string,              // 'ru' | 'en'
  },
  expertise: [{topic, level, noticed}],
  goals: [{goal, priority, addedAt}],
  preferences: { ... },        // freeform
  confidence: 0..1,            // overall self-assessed
  observedAt: ISO,
  source: 'default' | 'manual' | 'profile' | 'learn',
}
```

**Read:** `agentMemory.getUserProfile()` → IPC `memGetUserProfile`.
Injectable into the system prompt to colour the model's tone (planned
next: agentLoop optionally inserts a "Style guide for this user"
block).

**Write:** Inspector → Learned UI lets the user drag Big Five sliders,
pick formality/verbosity/address. Manual edits bump `confidence` by
+0.05 per change. Future: auto-update from `learnFromTurn` when a
strong signal is detected ("обращайся ко мне формально" →
formality='professional', confidence += 0.1).

**Killer feature angle:** Horizon SHOWS the model. User can see and
edit "what Horizon thinks of me". Hermes' Honcho is opaque; we expose
it.

---

## Type 6 — FTS Index 🟡 planned

SQLite FTS5 over memories.content + conversations.user + .assistant.
Gives us:
- Exact-phrase search (semantic is fuzzy — sometimes you want strict)
- Faster recall on tiny string fragments
- Per-token highlights for the Inspector

**Implementation:**
- New file `horizon_fts.db` next to the memory JSON
- Better-sqlite3 (already in deps? — check, otherwise add)
- Rebuild from JSON on init if missing or stale
- Incremental insert on `remember()` / `saveConversation()`

**Why not just embeddings:** Embeddings miss tokens that don't co-occur
in the training set; FTS catches them. Combined ranking (semantic + FTS
+ keyword) is more robust than any single signal.

---

## Type 7 — Persona Memory 🟡 planned

Per-persona overlay. When Jarvis is active, memories tagged
`personaId: 'jarvis'` are recall-boosted; Friday's memories sit dormant.
Implements "personality continuity" without leaking professional Sage
into casual Friday chats.

**Schema:**

```ts
_data.personaMemory = {
  jarvis: { facts: {...}, memories: [...] },
  friday: { facts: {...}, memories: [...] },
  ...
}
```

The main facts/memories stay shared (truly cross-persona). Persona
memory is an addition. Recall query checks both, weights by active
persona × 1.5.

**Inspired by:** Hermes' SOUL layer (per their docs — unexposed
implementation but the concept matches).

---

## Type 8 — Workspace Conventions 🟡 planned

`.horizon/memory.json` per workspace, committable to git. Schema:

```ts
{
  version: 1,
  workspace: { name, owner },
  conventions: [{rule, examples}],
  glossary: { acronym: definition },
  decisions: [{date, summary, link}],
  do_not: [...],
}
```

Loaded on workspace open, merged into the system prompt as a
"Workspace memory" block right after `.horizon/rules.md`. When the
team commits a new entry, every Horizon instance opening the repo gets
it instantly — onboarding for new devs becomes "git pull, Horizon
knows everything".

**Inspired by:** OpenClaw's project conventions concept (the most
useful idea from their codebase for team workflows).

---

## Memory write rules

1. **Facts are short and stable.** If you want to write "User likes mate
   and dark mode" — split it. Don't pack prose into a fact value.
2. **Memories carry context.** Every memory has a category + importance
   + source. Don't write category='general' importance=5 if you can be
   specific.
3. **Provenance is mandatory.** Every write specifies its `source`. If
   you call `remember()` without one, you get the default `'tool'`.
4. **Embedding is async.** New memories are indexed in the background;
   don't block the agent loop waiting for embeddings.
5. **Forget is final.** `forgetMemory` drops the sidecar vector too.
   There's no soft-delete recycle bin (yet — Trust Ledger will solve
   this in a future sprint).

---

## Verification checklist

After memory changes, the user should observe:

1. Inspector → Learned shows facts AND memories with provenance badges.
2. Hover any row → edit/forget buttons appear; both work.
3. User Profile sliders → drag → save → reload → values persist.
4. Reindex now → batch embeddings backfill via Gemini batch endpoint;
   chat message confirms count.
5. Source badges colour-coded: chat blue, telegram blue-deep, learn
   amber, manual green, agent purple, tool orange.

Future verification (after types 6-8 ship):
- FTS search finds an exact phrase that semantic misses.
- Switching persona changes which memories surface first in recall.
- Dropping a `.horizon/memory.json` in a workspace and opening it →
  conventions auto-load in the prompt without restart.
