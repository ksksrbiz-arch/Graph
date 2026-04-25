# Graph — Personal Knowledge Graph

A web app that ingests your digital footprint and renders it as an interactive force-directed graph.

This repo currently ships a **lean MVP slice** of the larger spec: a static viewer plus a Claude Code conversation ingester. No databases, no Docker, no auth — just a JSON file and a browser. The full architecture lives in [`docs/enhanced-personal-knowledge-graph-prompt.md`](docs/enhanced-personal-knowledge-graph-prompt.md) and we'll grow into it phase by phase.

## Quick start

```bash
# 1. Build a graph from your local Claude Code conversations (~/.claude/projects/*)
npm run ingest:claude-code

# 2. Open the viewer
npm start
# → http://localhost:3000
```

No `npm install` required — the project has zero runtime dependencies. Node 18+ is the only prerequisite. The viewer loads `force-graph` from a CDN at runtime.

## What gets ingested today

The ingester reads `~/.claude/projects/<encoded-cwd>/<session>.jsonl` (override with `CLAUDE_HOME=...`) and produces nodes and edges in `data/graph.json`:

| Node type       | Source                                                         |
| --------------- | -------------------------------------------------------------- |
| `project`       | One per Claude Code project directory (label = `cwd` basename) |
| `conversation`  | One per session JSONL (label = AI title / first user prompt)   |
| `tool`          | Each Claude tool name used (`Bash`, `Read`, `Edit`, …)         |
| `file`          | Absolute file paths referenced via tool inputs                 |
| `model`         | Each Claude model id seen in assistant messages                |

Edges: `project —CONTAINS→ conversation`, `conversation —USED→ tool`, `conversation —TOUCHED→ file`, `conversation —USED_MODEL→ model`, `file —PART_OF→ project` (when the file lives under the project's `cwd`).

Re-running the ingester is idempotent and merge-safe — node metadata is updated, edge `weight` and `count` accumulate.

## Layout

```
data/graph.json              # Generated graph (single source of truth)
web/                         # Static viewer (HTML + CSS + JS, no build step)
scripts/serve.mjs            # Zero-dep static dev server
scripts/ingest-claude-code.mjs
scripts/lib/graph-store.mjs  # Schema-aligned KGNode/KGEdge upsert helpers
docs/                        # Full v2.0 spec
```

The `KGNode` / `KGEdge` shapes in `graph-store.mjs` mirror the type contracts in §5 of the spec, so additional connectors can plug into the same store without changing the viewer.

## Roadmap (next slices)

1. **More connectors:** Claude.ai web export (`conversations.json`), GitHub issues/PRs, browser bookmarks (OPML).
2. **Concept extraction:** lightweight TF-IDF / embedding-based concept nodes linked to conversations.
3. **Backend:** swap `data/graph.json` for the Neo4j + NestJS API described in §6 of the spec, behind the same client contract.
4. **Multi-user + auth:** Phase 1+ of the spec.

## Architecture (target)

See the [full v2.0 specification](docs/enhanced-personal-knowledge-graph-prompt.md) — React 18 + react-force-graph, NestJS 10, Neo4j 5, PostgreSQL 15, Redis 7, Meilisearch.
