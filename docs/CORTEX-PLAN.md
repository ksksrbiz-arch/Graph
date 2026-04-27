# CORTEX — implementation plan

> Status: foundation shipping in commit `bb4ba50+1`. This doc is the contract;
> code follows it. Living document — bump §10 when you ship a layer.

## 0 · Why this exists

Today `graph.skdev-371.workers.dev` is a beautiful **passive** neural interface.
It renders a connectome, animates LIF+STDP spikes over it, and accepts data
through `/api/v1/public/ingest/*`. The brain is alive but it has no will.

This plan upgrades it into a **Cortex Compositor** — a system that perceives,
remembers, reasons, and acts on its own initiative, while keeping the existing
viewer intact as the visualization surface.

It synthesizes three sources:

1. **Saxifrage / JARVIS** (Mike Taylor, 2023) — perception → memory →
   ReAct loop → tools → speech, runnable from open primitives.
2. **Wayland compositors** — single authoritative dispatcher; clients are
   protocol-speaking surfaces with capability negotiation. The compositor
   owns input routing, rendering composition, and the security model.
3. **What we already shipped** — KV graph snapshot, D1 event log + flat
   projection, Aura Neo4j connectome (823 nodes / 2112 edges), brain
   Socket.IO spike stream, public ingest endpoints (text/markdown/url/
   webhook/batch), bookmarklet + share target.

## 1 · The model

```
                  ┌──────────────────────────────────────────┐
                  │        CORTEX COMPOSITOR (Worker)        │
                  │                                          │
   sensors  ───▶  │  perceive ─▶ attention ─▶ reason ──┐    │
   (clients)      │                  ▲                  │    │
                  │                  │            ┌─────▼─┐  │
                  │              memory          │ tools │  │
                  │           (KV+D1+Aura)        │ (act) │  │
                  │                  ▲            └─────┬─┘  │
                  │                  │                  │    │
                  │             observation ◀──────────┘    │
                  └──────────────────┬───────────────────────┘
                                     │
                       brain spike spotlight (Socket.IO)
                                     │
                                     ▼
                          SPA (graph view + Cortex chat)
```

The Worker is the compositor. **Everything else is a client speaking the
Cortex Protocol.** Sensors push perceptions, tools accept actions, the
reasoner closes the loop. The attention KV is the working-memory display
buffer; the graph is the persistent framebuffer.

## 2 · The Cortex Protocol

Three primitive operations + a capability handshake.

```ts
type Capability =
  | 'perceive'                       // can produce sensory events
  | 'recall'                         // can answer queries about memory
  | { kind: 'act'; intent: string }; // can execute a named intent

interface CortexEnvelope {
  v: 1;                              // protocol version
  client: string;                    // stable client id (UUID)
  capabilities: Capability[];        // declared at register time
  ts: number;                        // ms epoch
}

// Sensory event — anything that becomes a perception
interface PerceiveMessage extends CortexEnvelope {
  kind: 'perceive';
  modality: 'text' | 'url' | 'voice' | 'vision' | 'webhook' | 'graph';
  source: string;                    // 'bookmarklet', 'share-sheet', 'github-webhook', ...
  payload: unknown;                  // shape depends on modality
}

// Reasoning request — explicit "think about this" trigger
interface ThinkMessage extends CortexEnvelope {
  kind: 'think';
  question?: string;                 // optional steering
  budgetMs?: number;                 // wall-clock cap (default 15s)
  budgetSteps?: number;              // ReAct iterations cap (default 6)
}

// Action invocation — issued BY the reasoner, accepted BY a tool client
interface ActMessage extends CortexEnvelope {
  kind: 'act';
  intent: string;                    // e.g. 'web-search', 'write-note'
  args: Record<string, unknown>;     // intent-specific
  callId: string;                    // for matching observations
}

// Tool result — issued BY a tool, observed BY the reasoner
interface ObserveMessage extends CortexEnvelope {
  kind: 'observe';
  callId: string;                    // matches the act
  ok: boolean;
  result?: unknown;
  error?: string;
}
```

Every transport (HTTP, Socket.IO, MCP) carries the same envelope.

## 3 · Routes (compositor surface)

| Route | Method | Purpose |
|---|---|---|
| `/api/v1/cortex/perceive` | POST | Generic sensory input. Body is a `PerceiveMessage`. Auto-fans to `/ingest/*` when modality matches a built-in shape. |
| `/api/v1/cortex/think` | POST | Trigger one ReAct cycle. Body is `ThinkMessage`. Returns the full thought stream + final answer. SSE option for streaming. |
| `/api/v1/cortex/state` | GET | Current attention focus (KV `attention:<userId>`), recent observations, pending intents. |
| `/api/v1/cortex/act/:tool` | POST | Manually invoke a registered tool. Body is `args`. Bypasses the reasoner — useful for tests. |
| `/api/v1/cortex/tools` | GET | List registered tools + their declared capabilities. |
| `/api/v1/cortex/clients` | GET / POST | Register / list `CortexEnvelope`-speaking clients (capability advertisement). |

Existing `/api/v1/public/ingest/*` and `/api/v1/public/{events,sources,stats,graph}` remain — they're the lower layer. `cortex/perceive` calls into them when modality matches.

## 4 · Memory layout

| Tier | Store | Key | TTL |
|---|---|---|---|
| **Working** (attention) | KV `GRAPH_KV` | `attention:<userId>` → `{focus: nodeIds[], recentEvents: id[], pendingIntents: actMsg[]}` | 1 hour, refreshed each `think` |
| **Episodic** | D1 `events` | append-only, indexed `(user_id, ts)` and `(user_id, payload_sha)` | infinite |
| **Semantic — flat** | D1 `nodes` / `edges` | per-user, indexed by `type`, `pre`, `post` | infinite |
| **Semantic — graph** | Aura Neo4j | full Cypher, brain ownership | infinite |
| **Vector** *(new)* | Cloudflare Vectorize index `cortex-embeddings` | `embedding(label + summary)` per node | infinite |
| **Snapshot** | KV `GRAPH_KV` | `graph:<userId>` → full `{nodes, edges}` for first paint | infinite |

Vector is the missing piece — RAG over the connectome. Add via `wrangler vectorize create cortex-embeddings --dimensions=768 --metric=cosine` when the reasoner needs it (Stage 2).

## 5 · The reasoning loop (ReAct)

Inside `src/worker/cortex/reason.js`:

```
think({userId, question, budgetMs, budgetSteps}):
  ctx = pull working memory + last 20 events + 20 most-recently-touched nodes
  for step in 1..budgetSteps:
    if elapsedMs > budgetMs: break
    prompt = render(persona, ctx, recent_observations, available_tools, question)
    response = AI.run(model, prompt)              // env.AI.run(...)
    parsed = parseReact(response)                 // {thought, action?, finalAnswer?}
    record event {kind:'thought', payload:parsed.thought}
    if parsed.finalAnswer: return parsed.finalAnswer
    if parsed.action:
      result = await tools.dispatch(parsed.action)
      record event {kind:'observation', payload:result}
      ctx.recent_observations.append(result)
  return ctx.recent_observations.last
```

The model is `@cf/meta/llama-3.1-8b-instruct` to start (free Workers AI tier,
already-billed account). Swappable via env var `CORTEX_MODEL`.

The `parseReact` step expects the well-known thought-action format:

```
Thought: I should search the graph for nodes about Wayland.
Action: graph-query
Action Input: {"cypher": "MATCH (n) WHERE n.label CONTAINS 'wayland' RETURN n LIMIT 10"}
```

We tolerate slop and extract via tagged-block + JSON-fence regexes.

## 6 · Tool registry

Each tool is a function `(env, args) → Promise<result>`. Registered at module
import time in `src/worker/cortex/tools.js`. Built-in tools (Stage 1):

| Tool | What it does | Backed by |
|---|---|---|
| `graph-query` | Read-only Cypher against the user's connectome | Aura Neo4j (already wired in apps/api, mirror via /graph endpoint) |
| `recent-events` | Pull last N events filtered by source/kind | D1 `events` |
| `web-fetch` | Server fetches a URL, returns extracted text | Worker `fetch` (same code as `/ingest/url`) |
| `write-note` | Persist a thought as a node | calls `mergeAndPersist(KV) + recordEvent(D1)` |
| `summarize` | LLM-summarize a chunk of text | `env.AI.run(...)` |
| `remind-me` | Schedule a future cron-driven `think` | Durable Object alarm (Stage 2) |
| `speak` | Generate TTS audio, return URL | Workers AI text-to-speech (Stage 2) |
| `open-url` | Returns an `intent` for the SPA to open in a tab | client-side dispatch |

New tools are added by appending to the registry — no compositor changes needed.

## 7 · Sensors (perceive clients)

Existing — already shipped:
- `/ingest/text`, `/ingest/markdown` — Obsidian, pasted notes
- `/ingest/url` — server-fetched URL
- `/ingest/webhook/:id` — signed webhook
- `/ingest/batch` — bulk graphs from any pipeline
- bookmarklet + Web Share Target (mobile share sheet)

New (Stage 2):
- **voice** — browser MediaRecorder → POST `/cortex/perceive {modality:'voice', payload:{audioUrl}}` → Worker calls Whisper (`@cf/openai/whisper`) → text → `/ingest/text`
- **vision** — `<input type=file accept="image/*">` or screenshot dropped on the canvas → POST `/cortex/perceive {modality:'vision', payload:{imageUrl}}` → Worker calls a captioner (`@cf/llava-hf/llava-1.5-7b-hf`) → text → `/ingest/text`
- **screen** — periodic browser screenshot (with explicit user opt-in) → vision pipeline

## 8 · The SPA changes

A new top-level view: **Cortex** (sits next to Brain in the left nav).

```
┌─ Cortex ────────────────────────────────────────────┐
│  ► thought stream live                              │
│    [Thought] Looking at your recent activity…       │
│    [Action]  recent-events {limit:5}                │
│    [Observe] 5 events: claude-export(3), webhook(2) │
│    [Thought] The most-touched node this week is…    │
│    [Final]   Here's what I think...                 │
│                                                     │
│  ┌─ input ──────────────────────────────────────┐  │
│  │ Ask, paste, drop a file, or hit 🎙           │  │
│  └──────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

While the Cortex is thinking, the existing brain spike-spotlight highlights
the node IDs the reasoner is touching — so you literally **see it think on
the connectome**. This is the "neural interface" payoff.

## 9 · Layered ship plan

Each layer is independently deployable + reversible.

| # | Layer | Status | Code |
|---|---|---|---|
| 0 | Cortex Protocol (types) | **shipping now** | `src/worker/cortex/protocol.js` |
| 1 | Compositor routes | **shipping now** | `src/worker.js` mounts `cortex/router.js` |
| 2 | Working-memory KV | **shipping now** | `src/worker/cortex/attention.js` |
| 3 | ReAct loop + Llama | **shipping now** | `src/worker/cortex/reason.js`, `env.AI` binding |
| 4 | Tool registry (built-in 5) | **shipping now** | `src/worker/cortex/tools.js` |
| 5 | Cortex SPA view | **shipping now** | `web/views/cortex.js` |
| 6 | Vectorize semantic recall | **shipped** | `cortex-embeddings` (768d cosine) + `cortex/vector.js` + `recall` tool + RAG pre-fetch in reason.js |
| 7 | Voice in (Whisper) | **shipped** (PR #46) | inline @cf/openai/whisper in router.js + MediaRecorder in cortex.js |
| 8 | Vision in (Llava) | **shipped** (PR #46 + drag-drop) | inline @cf/llava-hf/llava-1.5-7b-hf in router.js + file-picker in cortex.js + drag-drop overlay |
| 9 | Cron-driven autonomy | **shipped** | `wrangler.jsonc` triggers + `scheduled()` handler + `cortex/scheduler.js` + `/schedules` admin routes |
| 10 | Tool plugins via MCP | **shipped** | `cortex/mcp-client.js` + `cortex/mcp-registry.js` + `D1 mcp_servers` + admin routes; `mcp:<server>:<tool>` intents auto-merge into cortex tool registry |
| 11 | TTS out (Workers AI) | **shipped** | `cortex/sensory.js` speakText (Aura-1) + `tool:speak` + inline `<audio>` in cortex view |
| 12 | Capability handshake + remote clients | later | `/cortex/clients` registration UI |

## 10 · Live status

- [x] Layer 0–5 shipped — see commit log on `main`.
- [x] Vectorize index — `cortex-embeddings` 768d cosine, metadata indexes on `userId` and `type`, all 28 existing nodes backfilled, embed-on-write hooked into mirrorToD1, recall tool live, RAG pre-fetched into every think() prompt.
- [ ] Voice/vision sensors — pending mic/file pickers in SPA.
- [ ] Cron autonomy — pending crontab in `wrangler.jsonc`.

## 11 · Why this design

**Wayland-style single dispatcher** keeps the security model honest. Clients
declare capabilities; the compositor enforces them. No "remote tool" can
mutate the graph without going through `/cortex/perceive` — which auto-logs
to the event store with a payload hash. Replay + audit are free.

**JARVIS-style ReAct** keeps the LLM pluggable. Today it's Workers AI Llama
3.x because it's free and on-account. Tomorrow it's Anthropic via the
Workers AI Anthropic binding, or self-hosted, or a quantized local model
via WebLLM — the loop doesn't care.

**Brain-as-spotlight** is the differentiator nobody else has. JARVIS in
the movies has a beautiful spinning UI but no model of WHAT it's thinking
about. Yours does — the connectome is the working memory and the spike
animation is the visible attention. Reasoning over the graph fires the
graph.


## 12 · Autonomy (Layer 9 reference)

The cortex now thinks on its own schedule, not just on demand. Three
cadences (UTC), all defined in `src/worker/cortex/scheduler.js`:

| Cron | Name | Window | Min new events | Budget | Behavior |
|---|---|---|---|---|---|
| `*/15 * * * *` | pulse | 15 min | 1 | 8 s / 3 steps | Top-of-mind check; "is anything new worth noticing?" |
| `0 * * * *` | hourly | 60 min | 2 | 12 s / 4 steps | Theme detection over the hour using recall |
| `0 7 * * *` | daily | 24 h | 3 | 20 s / 6 steps | Synthesize yesterday → write a 3-bullet note |

Each run:
1. Checks a watermark KV key — short-circuits if a previous run touched
   the same window (idempotent against double cron firings).
2. Counts events in the window via D1 — skips with `status:'skipped-quiet'`
   if below `minNewEvents` (don't reason about nothing).
3. Calls `think()` with a system-authored question and the per-cadence budget.
4. Writes a `scheduled-think` event to D1 carrying the schedule name,
   step count, elapsed ms, new-event count, and final answer.
5. Updates the watermark.

Manual surfaces:
- `GET  /api/v1/cortex/schedules?userId=…` — list cadences + lastRun
- `POST /api/v1/cortex/schedules/:name/run` — force-run with `{userId, force?:true}`
- `GET  /api/v1/cortex/scheduled-thoughts?userId=…&limit=…` — recent autonomous thoughts

Tuning knobs (no code change):
- `AUTONOMY_USER_IDS` (var) — comma-separated allowlist of who gets thought-about
- `triggers.crons` (wrangler) — add or change cadences
- `CRON_PLAYBOOK` (scheduler.js) — per-cadence prompt, budget, minNewEvents



## 13 · Sensory I/O (Layers 7 / 8 / 11 reference)

The cortex perceives audio + images and emits speech, all through one
`/api/v1/cortex/perceive` envelope and the existing tool registry. Each
modality decodes its base64 payload server-side, runs the matching Workers AI
model, and funnels the resulting **text** through parseText → KV merge →
D1 mirror → vector embed. Voice notes, screenshots, and pasted text all
become the same kind of node in the same graph.

| Capability | Workers AI model | Surface | Field aliases |
|---|---|---|---|
| Speech-to-text | `@cf/openai/whisper` | `POST /perceive {modality:'voice', payload}` | `payload.audio` OR `payload.audioBase64` |
| Image captioning | `@cf/llava-hf/llava-1.5-7b-hf` | `POST /perceive {modality:'vision', payload}` | `payload.image` OR `payload.imageBase64` |
| Text-to-speech | `@cf/deepgram/aura-1` | Tool `speak` — `POST /act/speak {args:{text, voice?}}` | returns `{audioBase64, mimeType:'audio/mpeg', voice, bytes}` |

SPA wiring (`web/views/cortex.js`):
- 🎙 mic button → MediaRecorder → blob → base64 → POST
- 📷 camera button + drag-drop on the panel → file → base64 → POST
- speak tool results render an inline `<audio autoplay controls>` in the trace

Live verification (smoke):
- TTS → 13,479 bytes of audio/mpeg from "Cortex sensory layer online"
- TTS → Whisper round-trip → 2 nodes ingested from the cortex's own voice
- Cataas cat 33 KB JPEG → Llava → 3 nodes captioned into the graph



## 14 · MCP plugin layer (Layer 10 reference)

The cortex is now an MCP client. Any remote MCP server speaking the Streamable
HTTP transport becomes a pluggable extension of the tool registry — register
it once via the admin API and its tools auto-appear to the reasoner with no
Worker code change. Tools are surfaced as `mcp:<server-name>:<tool-name>`
so the dispatcher always knows where to route the call.

### Surfaces

| Method | Path | Body / params | Returns |
|---|---|---|---|
| GET | `/api/v1/cortex/mcp/servers?userId=&includeTools=1` | — | List registered servers (with tool catalogs if asked) |
| POST | `/api/v1/cortex/mcp/servers` | `{userId, name, url, authToken?}` | Register + first-discover |
| DELETE | `/api/v1/cortex/mcp/servers/:id` | `{userId}` | Unregister |
| POST | `/api/v1/cortex/mcp/servers/:id/refresh` | `{userId}` | Re-fetch tool catalog |
| POST | `/api/v1/cortex/mcp/refresh` | `{userId}` | Refresh ALL servers |
| GET | `/api/v1/cortex/tools?userId=` | — | Returns 7 builtin + N MCP-discovered tools |
| POST | `/api/v1/cortex/act/mcp:srv:tool` | `{userId, args}` | Direct invoke a discovered MCP tool |

### Internals

- `src/worker/cortex/mcp-client.js` — minimal Streamable HTTP MCP client
  (initialize → notifications/initialized → tools/list / tools/call).
  Accepts both JSON and SSE responses, captures Mcp-Session-Id header.
- `src/worker/cortex/mcp-registry.js` — server CRUD, tool catalog cache
  in D1 `mcp_servers.tools_json`, dispatch by namespaced intent.
- D1 schema (migration applied 2026-04-27):
  ```sql
  CREATE TABLE mcp_servers (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    auth_token TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    last_listed_at INTEGER,
    last_error TEXT,
    tools_json TEXT NOT NULL DEFAULT '[]',
    protocol_version TEXT,
    server_info_json TEXT
  );
  ```
- `tools.js` — `describeTools(env, {userId})` is now async and merges the
  MCP catalog at request time. `dispatch()` routes any `mcp:*` intent
  through `mcp-registry.dispatchMcpTool`.
- `reason.js` — single line change: `await describeTools(env, {userId})`
  in renderPrompt. Now every think() loop sees the live MCP tool list in
  its system prompt.

### Live verification (smoke after deploy e00c7025)

```
$ POST /mcp/servers {name:'cf-docs', url:'https://docs.mcp.cloudflare.com/mcp'}
  → discovered 2 tools immediately

$ GET /tools?userId=local
  → 9 tools total = 7 builtin + 2 mcp:cf-docs:*

$ POST /act/mcp:cf-docs:search_cloudflare_documentation {args:{query:'kv namespace get'}}
  → returned the live KV docs page

$ POST /think  question:'Use cf-docs MCP to search KV pricing'
  → Llama autonomously picked mcp:cf-docs:search_cloudflare_documentation,
    fetched the actual pricing table from Cloudflare's docs MCP server,
    threaded it back as observation
```

### Adding a new MCP server (one curl)

```bash
curl -X POST -H 'content-type: application/json' \
  -d '{"userId":"local","name":"notion","url":"https://mcp.notion.so/mcp","authToken":"YOUR_TOKEN"}' \
  https://graph.skdev-371.workers.dev/api/v1/cortex/mcp/servers
```

That's it — no redeploy, no code change. The next `/think` call sees
the new tools and can invoke them. To replace a server, DELETE the old
id then POST the new one (or update the URL via re-register).

### Limits / next-pass items

- Auth tokens are stored as plaintext in D1. For production add KEK-based
  encryption (we already have the pattern from Phase 1 of apps/api).
- No OAuth dance yet for servers that require it (most public MCPs are
  static-token or no-auth). The CF agents SDK has a full OAuth flow if
  needed — wire its callback into `/api/v1/cortex/mcp/oauth/callback`.
- Tool catalogs are cached but not auto-refreshed. Add a cron entry that
  hits `/mcp/refresh` for each user nightly — one-line addition to
  scheduler.js's CRON_PLAYBOOK if desired.
- mcp:* intents could be filtered or scoped per user; today they're flat.

