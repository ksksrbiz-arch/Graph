# Graph — Personal Knowledge Graph

A web app that ingests your digital footprint and renders it as an interactive force-directed graph.

This repo currently ships a **runnable, single-user slice** of the larger [v2.0 spec](docs/enhanced-personal-knowledge-graph-prompt.md): a static viewer with a real multi-view UI plus a Claude Code conversation ingester. No databases, no Docker, no auth — just a JSON file, a tiny Node server, and a browser.

## Quick start

```bash
# 1. Build a graph from your local Claude Code conversations (~/.claude/projects/*)
npm run ingest:claude-code

# 2. Serve the app
npm start
# → http://localhost:3000
```

No `npm install` required — zero runtime dependencies. Node 18+ is the only prerequisite. The viewer pulls `force-graph` from a CDN at runtime.

You can also re-ingest from inside the app: click **Ingest Claude Code** in the top bar (or use the **Connectors** view).

## UI

| View | What it does |
| ---- | ------------ |
| **Graph** | Force-directed canvas. Hover dims non-neighbors, click selects, double-click via the side panel focuses the ego-network (depth-2 subgraph), right-click for a context menu. Type filters, edge-weight slider, legend, fit-to-view, zoom controls. |
| **Timeline** | Chronological list of nodes, grouped by day. Click any item to jump to the graph centered on it. |
| **Connectors** | Live status of every ingested source. One-click re-run; logs appear in the card. |
| **Search** | Full-text search across labels and metadata, with field-level match highlights. |
| **Settings** | Live physics sliders (charge, link distance, node size), label/particle toggles, auto-refresh, persisted in `localStorage`. |

Keyboard: `Esc` closes panel / clears focus, `f` fits the graph to the viewport.

## What gets ingested today

`scripts/ingest-claude-code.mjs` reads `~/.claude/projects/<encoded-cwd>/<session>.jsonl` (override with `CLAUDE_HOME=...`) and produces nodes and edges in `data/graph.json`:

| Node type       | Source                                                         |
| --------------- | -------------------------------------------------------------- |
| `project`       | One per Claude Code project directory (label = `cwd` basename) |
| `conversation`  | One per session JSONL (label = AI title / first user prompt)   |
| `tool`          | Each Claude tool name used (`Bash`, `Read`, `Edit`, …)         |
| `file`          | Absolute file paths referenced via tool inputs                 |
| `model`         | Each Claude model id seen in assistant messages                |

Edges: `project —CONTAINS→ conversation`, `conversation —USED→ tool`, `conversation —TOUCHED→ file`, `conversation —USED_MODEL→ model`, `file —PART_OF→ project` (when the file lives under the project's `cwd`).

Re-running is idempotent and merge-safe — node metadata is updated, edge `weight` and `metadata.count` accumulate.

## Layout

```
data/graph.json               # Generated graph (single source of truth)
web/
  index.html                  # App shell
  app.js                      # Bootstrap + hash router
  state.js                    # Shared store with subscribe/emit
  data.js                     # loadGraph, runIngest
  util.js                     # DOM + formatting helpers
  views/{graph,timeline,connectors,search,settings}.js
scripts/
  serve.mjs                   # Static server + POST /api/ingest/<slug>
  ingest-claude-code.mjs
  lib/graph-store.mjs         # Schema-aligned KGNode/KGEdge upsert helpers
docs/                         # Full v2.0 spec
```

The `KGNode` / `KGEdge` shapes in `graph-store.mjs` mirror the type contracts in §5 of the spec, so additional connectors plug into the same store and viewer without changes.

## API surface

The dev server is intentionally minimal — only one non-static route:

| Method | Path                       | Description                                                        |
| ------ | -------------------------- | ------------------------------------------------------------------ |
| `POST` | `/api/ingest/<slug>`       | Spawn `scripts/ingest-<slug>.mjs`. Returns `{ ok, code, stdout, stderr }`. |

When the spec's NestJS API arrives, the front-end will move to `/api/v1/graph/...` and `/api/v1/connectors/...` per §6 — the in-app calls are isolated to `web/data.js` so the swap stays small.

## Roadmap (next slices)

1. **More connectors:** Claude.ai web export (`conversations.json`), GitHub issues/PRs, browser bookmarks (OPML).
2. **Concept extraction:** lightweight TF-IDF / embedding-based concept nodes linked to conversations.
3. **Backend:** swap `data/graph.json` for the Neo4j + NestJS API in §6 of the spec, behind the `data.js` boundary.
4. **Multi-user + auth:** Phase 1+ of the spec.

## Architecture (target)

See the [full v2.0 specification](docs/enhanced-personal-knowledge-graph-prompt.md) — React 18 + react-force-graph, NestJS 10, Neo4j 5, PostgreSQL 15, Redis 7, Meilisearch.
