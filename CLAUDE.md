# CLAUDE.md

Guidance for Claude Code (and other AI agents) working in this repository.

## What this project is

**Graph — Personal Knowledge Graph Visualization System (PKG-VS).** A web app
that ingests your digital footprint (notes, code, git history, bookmarks,
email, chat exports, …) and renders it as an interactive force-directed graph
with a live "brain" layer (spiking neurons, STDP learning, attention, dreams,
recall) and a "cortex" reasoning/agent layer.

The full v2.0 specification is in
[`docs/enhanced-personal-knowledge-graph-prompt.md`](docs/enhanced-personal-knowledge-graph-prompt.md).
Phase-by-phase progress is tracked in
[`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md) — **read it
before claiming a feature is done or not done**, and tick a row when you ship a
DoD-satisfying change.

## The three coexisting tracks

This repo deliberately runs several implementations side by side. Know which one
you are touching:

1. **v1 static MVP** (`web/`, `scripts/`, `data/`) — zero-dependency, single
   user, no DB/auth/build step. `npm start` serves it; `scripts/ingest-*.mjs`
   build `data/graph.json`. This is what the public demo actually runs.
2. **Cloudflare Worker** (`src/worker/`, `wrangler.jsonc`, `migrations/d1/`) —
   fronts the SPA on the same origin and implements the public ingest API
   (`/api/v1/public/*`) plus the **cortex** reasoning/agent stack (ReAct loop on
   Workers AI, Vectorize recall, voice/vision in, TTS out, MCP tool plugins,
   cron autonomy). Persistence via Workers KV + D1.
3. **v2 monorepo** (`apps/`, `packages/`) — the spec-aligned implementation:
   `apps/api` (NestJS 10: REST + GraphQL + WebSocket, Neo4j/Postgres/Redis/
   Meilisearch, brain + motor + reasoning modules) and `apps/web` (Vite + React
   18 scaffold, full canvas migration queued for Phase 3).

A fourth, in-progress effort lives under `web/ui/` — **UI v2**, a ground-up
modular rebuild of the v1 viewer (orchestrator + pluggable 2D/3D renderers +
first-class brain animation). It is scaffolding/active work and does not yet
replace `web/`.

## Repo layout (high level)

```
apps/
  api/            # NestJS 10 service (v2): auth, users, graph, brain, motor,
                  #   reasoning, agent, arc, oauth, connectors, sync, public, audit
  web/            # Vite + React 18 client scaffold (Phase 3 target)
packages/
  shared/         # KGNode/KGEdge types + zod schemas + mocks (spec §5)
  cortex/         # deterministic six-phase cortex pipeline (used by apps/api)
  reasoning/      # reasoning primitives
  spiking/        # spiking-neuron simulator (LIF/STDP)
src/worker/       # Cloudflare Worker: ingress, auth, oauth, cortex/*, finance, d1-store
web/              # v1 static viewer (force-graph CDN, no build) + views/, hud/, ui/(v2)
scripts/          # v1 ingesters (*.mjs) + serve.mjs + mcp-server.mjs + seed-stack.mjs
data/graph.json   # v1 graph data (generated locally, gitignored)
docs/             # spec, IMPLEMENTATION_STATUS, ADRs, diagrams, CORTEX-PLAN, batch-upload
infra/postgres/   # bootstrap SQL
migrations/d1/    # Cloudflare D1 migrations
docker-compose.yml  openapi.yaml  wrangler.jsonc  render.yaml  fly.toml
```

## Common commands

```bash
# v1 (no install needed, Node 18+)
npm run ingest:claude-code     # build data/graph.json from ~/.claude/projects
npm start                      # serve web/ at http://localhost:3000
npm run mcp                    # stdio MCP server over data/graph.json

# v2 monorepo (pnpm 9 via corepack)
corepack enable && corepack use pnpm@9
pnpm install
pnpm stack:up                  # docker compose: Neo4j, Postgres, Redis, Meilisearch
pnpm stack:seed                # seed Neo4j with mock graph (userId=local)
pnpm --filter @pkg/api start:dev   # Swagger UI at http://localhost:3001/api/docs
pnpm --filter @pkg/web dev         # React scaffold at http://localhost:3000

# workspace-wide quality gates
pnpm lint
pnpm type-check
pnpm test
pnpm build

# per-package tests
pnpm --filter @pkg/api test            # unit
pnpm --filter @pkg/api test:cov        # coverage
pnpm --filter @pkg/api test:mutation   # Stryker

# Cloudflare Worker
pnpm run preview               # wrangler dev
pnpm run deploy                # wrangler deploy
```

All ingesters: `claude-code`, `git`, `markdown`, `code`, `zotero`, `webclip`,
`evernote`, `daily-note`, `github`, `bookmarks`, `claude-export`, `bank-csv`,
`pieces` (run as `npm run ingest:<name>`). They share
`scripts/lib/graph-store.mjs` and are idempotent (`weight` / `metadata.count`
accumulate across runs).

## Conventions & gotchas

- **Match the track you're in.** v1 code is zero-dependency vanilla JS modules;
  don't pull npm deps into `web/` or `scripts/`. v2 (`apps/`, `packages/`) is
  TypeScript + pnpm workspaces. The Worker (`src/worker/`) is plain JS targeting
  the Cloudflare runtime.
- **Shared data shape.** `KGNode` / `KGEdge` (spec §5, mirrored by zod in
  `packages/shared`) is the contract across all tracks. Keep ingesters, the
  Worker, and the Nest API aligned to it.
- **Generated data is gitignored.** `data/graph.json` and
  `web/data/graph.json` come from your own data — a fresh clone has none until
  you run an ingester. `pnpm data:sync` copies root → `web/`.
- **Document decisions.** Architecturally significant choices get an ADR under
  [`docs/adr/`](docs/adr/README.md). Status changes get reflected in
  `docs/IMPLEMENTATION_STATUS.md` and, for API modules, `apps/api/README.md`.
- **CI** (`.github/workflows/ci.yml`) runs lint + type-check + tests (e2e +
  Lighthouse + Stryker jobs gate on Phase-3 config). Run the relevant gate
  locally before pushing.
- **Don't break v1.** New phases land incrementally without regressing the
  runnable v1 demo.

## Where things live (quick map)

| Looking for… | Go to |
| ------------ | ----- |
| The spec / source of truth | `docs/enhanced-personal-knowledge-graph-prompt.md` |
| What's done vs. pending | `docs/IMPLEMENTATION_STATUS.md` |
| v1 graph viewer | `web/` (`app.js`, `views/`, `hud/`) |
| v1 → graph.json ingestion | `scripts/ingest-*.mjs`, `scripts/lib/` |
| MCP access to the graph | `scripts/mcp-server.mjs` |
| Public ingest + cortex (online) | `src/worker/` (`ingress.js`, `cortex/`) |
| NestJS REST/GraphQL/WS API | `apps/api/src/` |
| Brain (spiking, attention, dreams, recall) | `apps/api/src/brain/`, `packages/spiking/` |
| Deterministic cortex pipeline | `packages/cortex/`, `apps/api/src/brain/cortex.service.ts` |
| Shared types/schemas | `packages/shared/` |
</content>
</invoke>
