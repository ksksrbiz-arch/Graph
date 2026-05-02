# Graph — Personal Knowledge Graph Visualization System (PKG-VS)

A web app that ingests your digital footprint (email, notes, calendar, code, bookmarks…) and renders it as an interactive force-directed graph. See the full v2.0 specification at [`docs/enhanced-personal-knowledge-graph-prompt.md`](docs/enhanced-personal-knowledge-graph-prompt.md).

The repo holds **two coexisting tracks**:

1. **v1 static MVP** — the existing, runnable, single-user slice (no DB, no Docker, no auth). Lives under `web/`, `scripts/`, and `data/`.
2. **v2 monorepo (Phase 0+)** — the spec-aligned implementation under `apps/` and `packages/`, backed by Neo4j + Postgres + Redis + Meilisearch.

Phase progress is tracked in [`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md).

---

## Prerequisites

- **v1 quick start**: Node 18+ only.
- **v2 monorepo**: Node 18+, pnpm 9 (via `corepack`), Docker (for the local data stack).

## v1 quick start (no install)

```bash
npm run ingest:claude-code   # build data/graph.json from ~/.claude/projects
npm start                    # http://localhost:3000
```

Zero runtime dependencies. Ingesters available: `claude-code`, `git`, `markdown`, `code` (via a local [GitNexus](https://github.com/abhigyanpatwari/GitNexus) `gitnexus serve` HTTP server — see [`scripts/ingest-code.mjs`](scripts/ingest-code.mjs) for env vars and usage).

### Expose the graph over MCP

`scripts/mcp-server.mjs` is a stdio [Model Context Protocol](https://modelcontextprotocol.io) server that lets Claude Desktop, Cursor, Codex CLI, and other MCP clients read and search the personal knowledge graph (`data/graph.json`) without any extra plumbing. Zero dependencies — same Node 18+ as the rest of the v1 scripts.

Tools: `search_nodes`, `get_node`, `subgraph`, `list_sources`, `stats`. Resources: `graph://snapshot`, `graph://sources`. See the header of [`scripts/mcp-server.mjs`](scripts/mcp-server.mjs) for the full schema.

```jsonc
// ~/.config/Claude/claude_desktop_config.json (or your editor's MCP config)
{
  "mcpServers": {
    "graph-pkg": {
      "command": "node",
      "args": ["/absolute/path/to/Graph/scripts/mcp-server.mjs"]
    }
  }
}
```

Or run it manually for debugging:

```bash
npm run mcp   # speaks JSON-RPC 2.0 over stdio
```

> `data/graph.json` and `web/data/graph.json` are **generated locally from your own data** and are gitignored. A fresh clone has no graph until you run an ingester.

## v2 quick start (monorepo)

```bash
# 1. Install pnpm (Node 18+)
corepack enable && corepack use pnpm@9

# 2. Install workspace deps
pnpm install

# 3. Bring up the data services
pnpm stack:up                # docker compose up -d

# 4. Seed Neo4j with a mock graph (one-shot, idempotent)
pnpm stack:seed              # populates userId=local with ~120 nodes

# 5. Run the API in watch mode
pnpm --filter @pkg/api start:dev
# Swagger UI at http://localhost:3001/api/docs

# 6. (Optional) run the React 18 client scaffold
pnpm --filter @pkg/web dev   # http://localhost:3000
```

Bring everything down with `pnpm stack:down`.

## Always-on deployment

- Deploy `apps/api` as a long-running container service; the repo now includes a production-ready `apps/api/Dockerfile` and a `render.yaml` blueprint.
- Point `POSTGRES_URL`, `NEO4J_*`, `REDIS_URL`, and `MEILI_*` at hosted services instead of the local `docker-compose.yml` stack.
- Set `API_PUBLIC_URL` and `CORS_ORIGINS` so OAuth callbacks, browser CORS, and Socket.IO all target the hosted API correctly.
- Set `BRAIN_AUTO_START_USER_IDS` to the user ids whose brains should resume automatically after deploys/restarts.
- Set `PUBLIC_INGEST_USER_IDS` to the demo user ids that may write through the anonymous `/api/v1/public/ingest/*` endpoints — the Cloudflare-hosted website uses this to live-ingest pasted text/markdown directly into the public brain.
- Keep `wrangler.jsonc`/`web/` for the static frontend and set `web/config.js` during deployment so the SPA connects to the hosted API.

### Cloudflare Worker (same-origin online API)

The `wrangler.jsonc` Worker fronts the SPA **and** implements the public ingest API on the same origin (`/api/v1/public/*`), so the deploy at `https://graph.skdev-371.workers.dev/` persists graph nodes across visits without requiring the Fly.io Nest API. Persistence uses a Workers KV namespace (binding `GRAPH_KV`); the local dev server (`pnpm start`) and the static `data/graph.json` are used as fallbacks when the online API is unreachable.

```bash
# 1. Create a KV namespace (one-time per environment)
pnpm exec wrangler kv namespace create GRAPH_KV
pnpm exec wrangler kv namespace create GRAPH_KV --preview

# 2. Paste the returned `id` and `preview_id` into `wrangler.jsonc`
#    (replace REPLACE_WITH_KV_NAMESPACE_ID / REPLACE_WITH_KV_PREVIEW_ID).

# 3. Deploy
pnpm run deploy
```

Without a KV binding the Worker still serves the static SPA, but the public ingest endpoints respond with `{ enabled: false }` and the SPA falls back to read-only mode.

---

## Repo layout

```
.
├── apps/
│   └── api/                  # NestJS REST + GraphQL + WebSocket (Phase 0+)
├── packages/
│   └── shared/               # KGNode/KGEdge types + zod schemas + mocks (§5)
├── docs/
│   ├── adr/                  # Architecture Decision Records (Rule 6)
│   ├── diagrams/             # Mermaid: C4, ERD, sync sequence, NLP pipeline
│   ├── IMPLEMENTATION_STATUS.md
│   └── enhanced-personal-knowledge-graph-prompt.md   # full v2.0 spec
├── infra/
│   └── postgres/init/        # bootstrap SQL (users, audit, connectors, …)
├── scripts/                  # v1 ingesters (claude-code, git, markdown)
├── web/                      # v1 static viewer (force-graph CDN, no build)
├── data/graph.json           # v1 graph data
├── docker-compose.yml        # Neo4j, Postgres, Redis, Meilisearch
├── openapi.yaml              # v1 REST contract (Rule 7)
├── pnpm-workspace.yaml
└── .github/workflows/ci.yml  # lint + type-check + tests + Lighthouse + Stryker
```

---

## v1 UI

| View | What it does |
| ---- | ------------ |
| **Graph** | Force-directed canvas. Hover dims non-neighbours, click selects, double-click focuses ego-network (depth-2). Type filters, edge-weight slider, legend, fit-to-view, zoom controls. |
| **Timeline** | Chronological list of nodes, grouped by day. Click any item to jump to the graph. |
| **Connectors** | Live status of every ingested source. One-click re-run; logs appear in the card. |
| **Search** | Full-text across labels and metadata, with field-level match highlights. |
| **Settings** | Live physics sliders (charge, link distance, node size), label/particle toggles, auto-refresh. Persisted in `localStorage`. |

Keyboard: `Esc` closes panel / clears focus, `f` fits the graph to the viewport.

## Brain ingest features

The graph view ships with a docked **Brain ingest** panel (top-right) and an
animation overlay that lights up freshly-arrived nodes in real time.

**Ingest paths** — both call the existing public ingest API:

| Tab  | What it sends                                                                    |
| ---- | -------------------------------------------------------------------------------- |
| URL  | `fetch(url)` in your browser, strips tags, posts cleaned text to `/api/v1/public/ingest/text`. CORS will block many sites — the panel surfaces that as a clear error and falls back to "paste the text yourself". |
| Text | Pastes text or markdown directly. Auto-detects markdown (headings or `[[wikilinks]]`) and routes to `/markdown` accordingly. |
| Log  | In-memory history of recent ingestion attempts with status + node counts.        |

Backend wiring:

- `POST /api/v1/public/ingest/text` and `POST /api/v1/public/ingest/markdown` — parse text into `KGNode`s + `KGEdge`s, persist via Neo4j, perceive into the running brain, and queue a debounced connectome reload.
- `GET /api/v1/public/graph/delta?userId=…&since=<ISO|epoch_ms>` — returns nodes + edges with `createdAt > since`. Drives the SPA poll loop (`web/graph-live.js`, default 3s cadence).

**Live animations** (overlay over `force-graph`, 2D mode):

- **Procedural spawn** — each newly-arrived node scales in with an axon-style particle stream from a random existing neighbour.
- **Query trace** — focusing a node (search → click, or a graph click → ego-network) ripples a BFS wave through up to 5 hops of neighbours, raising heat on touched nodes.
- **Inference arc** — `brainAnimation.inferenceArc(from, to, reason)` is exposed for future use (long-distance reasoning hops); not auto-fired yet.

**Required env on the API** (already set on Fly demo deploy):

```ini
PUBLIC_INGEST_USER_IDS = "local"        # allowlist for the demo userId
PUBLIC_INGEST_MAX_BYTES = 262144        # 256 KB default per request
BRAIN_AUTO_START_USER_IDS = "local"     # so spike-stream + STDP run on boot
```

The 3D / 4D renderers don't draw the overlay yet — particles and glow are 2D-only for now. The animation engine still tracks state in 3D, so the panel and log update; only the canvas projection is gated to `renderer.kind === '2d'`.

## v1 ingesters

`scripts/ingest-*.mjs` write to `data/graph.json` via `scripts/lib/graph-store.mjs` (schema-aligned with §5 of the spec — same `KGNode` / `KGEdge` shape the v2 API will store).

| Script              | Source                                                          |
| ------------------- | --------------------------------------------------------------- |
| `claude-code`       | `~/.claude/projects/<encoded-cwd>/<session>.jsonl`              |
| `git`               | Local git repos (commits, files, authors)                       |
| `markdown`          | A directory of markdown notes (wikilinks → `LINKS_TO` edges)    |
| `pieces`            | A local [Pieces OS](https://pieces.app) MCP server (LTM memories, snippets) — see below |

Re-running is idempotent — `weight` and `metadata.count` accumulate across runs.

### Pieces MCP (ingest from Pieces OS LTM)

If you run [Pieces OS](https://pieces.app) locally it advertises a Model Context Protocol endpoint over Streamable-HTTP — by default at `http://localhost:39300/model_context_protocol/2025-03-26/mcp`. `scripts/ingest-pieces-mcp.mjs` is an MCP **client** that talks to that endpoint, calls a retrieval tool (default `ask_pieces_ltm`), and merges the returned memories/snippets into `data/graph.json` as `pieces-memory` nodes hanging off a `Pieces OS` source node, with `pieces-query --ANSWERED_BY--> pieces-memory` edges.

```bash
# 1. Verify the connection and see which tools the local Pieces MCP exposes:
npm run ingest:pieces:list-tools

# 2. Default ingest (asks Pieces LTM a generic recap question):
npm run ingest:pieces

# 3. Custom prompt(s) — semicolon-separated for multiple:
PIECES_QUERIES="What did I save about graph databases?;Recent code snippets about Neo4j" \
  npm run ingest:pieces
```

Useful env vars (full list in the header of `scripts/ingest-pieces-mcp.mjs`):

| Variable             | Default                                                                       |
| -------------------- | ----------------------------------------------------------------------------- |
| `PIECES_MCP_URL`     | `http://localhost:39300/model_context_protocol/2025-03-26/mcp`                |
| `PIECES_QUERY_TOOL`  | `ask_pieces_ltm`                                                              |
| `PIECES_QUERY_ARG`   | `question` (the string field on the tool's input schema)                      |
| `PIECES_AUTH_TOKEN`  | _(unset)_ — local Pieces OS doesn't require one                               |

A sample MCP client config (also documenting how to register Pieces with the v2 cortex MCP registry) lives at [`docs/mcp-clients/pieces.json`](docs/mcp-clients/pieces.json). The ingester reuses the same MCP HTTP client (`src/worker/cortex/mcp-client.js`) the v2 Worker uses, so JSON-RPC framing, SSE handling, and session management stay consistent across v1 ingestion and v2 dispatch.

---

## v2 architecture (target — see spec §3)

```
React 18 + react-force-graph   ─┐
                                ├─→  NestJS 10 (REST + GraphQL + WebSocket)
                                │     ├─→ Neo4j 5         (graph store)
                                │     ├─→ PostgreSQL 15   (users, audit, configs)
                                │     ├─→ Redis 7 (BullMQ) (sync queues, cache)
                                │     └─→ Meilisearch     (full-text search)
                                │
External OAuth (Google, GitHub, Microsoft, Notion, Todoist, Linear)
```

Decisions are logged in [`docs/adr/`](docs/adr/README.md).

## Roadmap

The 8-phase plan from spec §12 lives in [`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md). Phase 0 (Foundation) is mostly green; subsequent phases land incrementally without breaking the v1 MVP.
