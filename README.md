# Graph — Personal Knowledge Graph Visualization System (PKG-VS)

A web app that ingests your digital footprint (email, notes, calendar, code, bookmarks…) and renders it as an interactive force-directed graph. See the full v2.0 specification at [`docs/enhanced-personal-knowledge-graph-prompt.md`](docs/enhanced-personal-knowledge-graph-prompt.md).

The repo holds **two coexisting tracks**:

1. **v1 static MVP** — the existing, runnable, single-user slice (no DB, no Docker, no auth). Lives under `web/`, `scripts/`, and `data/`.
2. **v2 monorepo (Phase 0+)** — the spec-aligned implementation under `apps/` and `packages/`, backed by Neo4j + Postgres + Redis + Meilisearch.

Phase progress is tracked in [`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md).

---

## v1 quick start (no install)

```bash
npm run ingest:claude-code   # build data/graph.json from ~/.claude/projects
npm start                    # http://localhost:3000
```

Zero runtime dependencies. Ingesters available: `claude-code`, `git`, `markdown`.

## v2 quick start (monorepo)

```bash
# 1. Install pnpm (Node 18+)
corepack enable && corepack use pnpm@9

# 2. Install workspace deps
pnpm install

# 3. Bring up the data services
pnpm stack:up                # docker compose up -d

# 4. Run the API in watch mode
pnpm --filter @pkg/api start:dev
# Swagger UI at http://localhost:3001/api/docs
```

Bring everything down with `pnpm stack:down`.

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

## v1 ingesters

`scripts/ingest-*.mjs` write to `data/graph.json` via `scripts/lib/graph-store.mjs` (schema-aligned with §5 of the spec — same `KGNode` / `KGEdge` shape the v2 API will store).

| Script              | Source                                                          |
| ------------------- | --------------------------------------------------------------- |
| `claude-code`       | `~/.claude/projects/<encoded-cwd>/<session>.jsonl`              |
| `git`               | Local git repos (commits, files, authors)                       |
| `markdown`          | A directory of markdown notes (wikilinks → `LINKS_TO` edges)    |

Re-running is idempotent — `weight` and `metadata.count` accumulate across runs.

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
