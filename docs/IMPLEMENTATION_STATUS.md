# Implementation Status

Tracks progress against the 8-phase roadmap (spec §12). Update this file alongside any DoD-satisfying PR.

Legend: ✅ done · 🟡 partial · ⬜ not started · ❌ blocked

## Phase 0 — Foundation (Week 1–2)

| DoD item                                                       | Status | Notes |
| -------------------------------------------------------------- | ------ | ----- |
| Monorepo scaffold (pnpm workspaces): `apps/web`, `apps/api`, `packages/shared` | ✅ | `apps/web` ships as a Vite + React 18 scaffold; v1 static MVP under `/web` continues to serve the live demo until the canvas migration in Phase 3 |
| Docker Compose with Neo4j, PostgreSQL, Redis, Meilisearch     | ✅ | `docker-compose.yml` |
| `docker compose up` brings up all services with seed data     | ✅ | `pnpm stack:up && pnpm stack:seed` (`scripts/seed-stack.mjs` populates Neo4j with mock graph for `userId=local`) |
| CI pipeline: lint + type-check + unit tests pass on every PR  | ✅ | `.github/workflows/ci.yml` (e2e + lighthouse jobs gated on phase-3 config files) |
| Shared TypeScript interfaces + JSON schemas published from `packages/shared` | ✅ | zod schemas mirror types |
| README with local dev setup instructions                      | ✅ | |
| Live, public ingest from the Cloudflare-hosted website        | ✅ | `apps/api/src/public/*` exposes `POST /api/v1/public/ingest/{text,markdown}` + `GET /api/v1/public/graph`; web client opens a paste dialog and the brain perceives new nodes within seconds |

## Phase 1 — Auth & User Management (Week 3)

| DoD item                                              | Status | Notes |
| ----------------------------------------------------- | ------ | ----- |
| JWT authentication (login, refresh, logout)           | ✅ | `AuthService.login/register/refresh/logout` with bcrypt + SHA-256 token hashing; `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout` |
| OAuth2 integration scaffold                           | ✅ | `OAuthService` + providers (GitHub, Google Calendar, Notion); PKCE support; in-memory `ConnectorConfigStore` (Postgres migration Phase 4) |
| User table in PostgreSQL; profile CRUD                | ✅ | `UsersService` wraps `pg.Pool`; `GET/PATCH/DELETE /users/me` in `UsersController` |
| Audit log table + middleware wired                    | ✅ | `AuditService.record()` writes to `audit_events`; `AuditInterceptor` auto-logs all mutating routes globally (via `APP_INTERCEPTOR`) |
| Unit tests: 90% coverage on auth module               | ✅ | `auth.service.spec.ts` (14 tests), `users.service.spec.ts` (10 tests), `audit.service.spec.ts` (3 tests) — 101 total passing |

## Phase 2 — Graph Core (Week 4–5)

| DoD item                                                | Status | Notes |
| ------------------------------------------------------- | ------ | ----- |
| Neo4j connection provider + repository pattern          | ✅ | |
| REST + GraphQL endpoints for nodes/edges/subgraph       | ✅ | REST: `GET /graph/nodes` (cursor-paged), `GET /graph/nodes/:id`, `GET /graph/subgraph`, `GET /graph/search`, `DELETE /nodes/:id`. GraphQL (code-first, Apollo): `nodes`, `node`, `subgraph`, `searchNodes` queries via `GraphResolver` |
| Meilisearch node indexing + search endpoint             | ✅ | `SearchService` in `src/shared/meilisearch/`; nodes indexed on upsert, removed on delete; `GET /graph/search?q=` endpoint |
| WebSocket gateway (Socket.IO) for `graph:delta` events  | ✅ | `GraphGateway` in `/graph` namespace; emits `graph:delta` (NODES_ADDED/UPDATED/DELETED, EDGES_ADDED/DELETED) on every write via `GraphService` |
| Unit + integration tests for graph repository           | ✅ | `graph.repository.spec.ts` (16 tests: idempotency + subgraph + snapshotForUser + listNodes + getNode), `graph.service.spec.ts` (7 tests incl. search+delta), `graph.controller.spec.ts` (7 tests) |

## Brain layer follow-ups (post-LIF/STDP merge)

| Item                                                                                  | Status | Notes |
| ------------------------------------------------------------------------------------- | ------ | ----- |
| Periodic + on-shutdown weight checkpoints (5 min interval, Δ ≥ 0.02)                  | ✅ | `BrainService.checkpoint()` + `setInterval` per running brain + `onModuleDestroy` flush |
| `POST /brain/checkpoint` to force-flush from a client                                 | ✅ | JWT-guarded |
| `SensoryService.perceive(userId, node)` — connectors fire neurons on new node sync    | ✅ | Region-weighted current (sensory 30 mV, executive 22, limbic 18, motor 14, association/memory 12) |
| `POST /brain/perceive/:neuronId` smoke endpoint                                       | ✅ | JWT-guarded; synthesises a sensory pulse |
| Motor cortex safety supervisor — denylist + rate-limit + low-confidence + approval    | ✅ | `SafetySupervisor.evaluate()`, ring-buffered recent decisions |
| `POST /motor/evaluate`, `GET /motor/recent`                                           | ✅ | JWT-guarded |
| `tools/sniff-brain.mjs` reusable Socket.IO tap, `npm run sniff:brain`            | ✅ | Reports spikes/sec + region histogram + weight-change rate from a live brain |

## Brain layer phase 2 (Attention + Dreams + Recall)

| Item | Status | Notes |
|------|--------|-------|
| AttentionService — POST /brain/attend with label-or-neuron-id query | ✅ | Single focus per user, 30s default, auto-clear; resolves via Cypher `COUNT { (n)--() }` (Neo4j 5+) |
| DreamService — 5min awake / 30s sleep cycle, replay during sleep | ✅ | Skips sleep when attention active; emits `dream` events on /brain |
| RecallService — co-firing pair memories with half-life decay | ✅ | GET /brain/recall returns top-N; pruned at 2× cap |
| BrainService runtime levers — onSpike, setStimulationGain, setNoiseGain | ✅ | Per-user listeners on RunningBrain; stim gain applied in tick(), noise gain via SpikingSimulator.setNoiseRate() |
| BrainGateway emitDream broadcast | ✅ | clients can show wake/sleep state |

## Cortex compositor layers (cross-cutting — see `CORTEX-PLAN.md` for detail)

| # | Layer | Status | Code |
|---|---|---|---|
| 0 | Cortex Protocol (types) | ✅ | `src/worker/cortex/protocol.js` |
| 1 | Compositor routes | ✅ | `src/worker.js` → `cortex/router.js` |
| 2 | Working-memory KV | ✅ | `src/worker/cortex/attention.js` |
| 3 | ReAct loop + Llama 3.3 70B | ✅ | `src/worker/cortex/reason.js`, `env.AI` binding |
| 4 | Tool registry (built-in 7) | ✅ | `src/worker/cortex/tools.js` |
| 5 | Cortex SPA view | ✅ | `web/views/cortex.js` |
| 6 | Vectorize semantic recall | ✅ | `cortex-embeddings` 768d cosine + `cortex/vector.js` + recall tool + RAG pre-fetch |
| 7 | Voice in (Whisper) | ✅ | `@cf/openai/whisper` in `router.js` + MediaRecorder in `cortex.js` |
| 8 | Vision in (Llava) | ✅ | `@cf/llava-hf/llava-1.5-7b-hf` in `router.js` + file-picker + drag-drop |
| 9 | Cron-driven autonomy | ✅ | `cortex/scheduler.js` + `scheduled()` handler + `/schedules` admin routes |
| 10 | Tool plugins via MCP | ✅ | `cortex/mcp-client.js` + `cortex/mcp-registry.js` + D1 `mcp_servers` |
| 11 | TTS out (Workers AI) | ✅ | `cortex/sensory.js` speakText (Aura-1) + `tool:speak` |
| 12 | Capability handshake + remote clients | ⬜ | `/cortex/clients` registration UI |
| 13 | NestJS deterministic cortex | ✅ | `packages/cortex/` six-phase pipeline + `apps/api/src/brain/cortex.service.ts` |

## Phase 3 — Frontend Canvas (Week 6–7) 🔜 _active_

> **Goal**: migrate from the v1 static viewer under `/web` to a spec-grade, API-driven React canvas in `apps/web`.

### 3a · Graph canvas core

First slice landed in `apps/web/src/graph/` (`GraphView`, `NodePanel`,
`FilterPanel`, `ContextMenu`, `api.ts`, `types.ts`) using `react-force-graph-2d`.
Loads the full snapshot via `GET /api/v1/public/graph` (Phase-0 anon mode) and
uses `GET /graph/subgraph` for ego-focus.

| DoD item (spec §7.2) | AC | Status | Notes |
|-----------------------|----|--------|-------|
| `<GraphCanvas />` renders nodes from API as force-directed layout | AC-F01 | ✅ | `GraphView` via `react-force-graph-2d`; loads `GET /public/graph` snapshot. Large-graph perf benchmark still pending (see F13/F14) |
| Node colour encodes `NodeType` via 12-colour contrast-compliant palette | AC-F02 | ✅ | `packages/shared/src/palette.ts` (`PALETTE_12`, `NODE_TYPE_COLORS`, `colorForNodeType`) |
| Node size encodes degree (min 4 px, max 24 px radius) | AC-F03 | ✅ | `radiusOf()` — `4 + min(20, √degree·3)` |
| Hovering a node shows tooltip: `label`, `type`, `sourceUrl`, `updatedAt` | AC-F04 | ✅ | `nodeLabel` HTML tooltip + neighbour-dimming on hover |
| Click opens side panel with full metadata + outgoing/incoming edges | AC-F05 | ✅ | `NodePanel` (metadata, JSON, in/out connections, expand/delete) |
| Double-click re-centres on ego-network (depth-2) | AC-F06 | ✅ | `focusEgo()` calls `GET /graph/subgraph` (local BFS fallback) + `zoomToFit` |
| Right-click context menu: Open source, Copy link, Delete node, Expand neighbourhood | AC-F07 | ✅ | `ContextMenu` |
| Multi-select (Shift+Click); bulk delete (Delete key) | AC-F08 | ✅ | `selectedIds` set + `Delete`/`Backspace` bulk delete |
| Filter panel — client-side node/edge masking without re-fetch | AC-F09 | ✅ | `FilterPanel` toggles via `nodeVisibility`/`linkVisibility` (positions preserved) |
| Zoom (scroll/pinch) + Pan (drag) | AC-F10 | ✅ | force-graph built-in |
| Fit-to-screen button (shortcut `F`) | AC-F11 | ✅ | toolbar `Fit` + `F` key |
| Minimap (collapsible, bottom-right) | AC-F12 | ✅ | `MiniMap.tsx`, wired into `GraphView` (viewport rect from `onZoom`, click-to-jump) |
| 60 fps @ 5,000 nodes on 2021-era desktop (Chrome 120+) | AC-F13 | ⬜ | not yet benchmarked; bundle code-split also pending |
| 30 fps @ 5,000 nodes on mid-range mobile (Safari iOS 17+) | AC-F14 | ⬜ | not yet benchmarked |

### 3b · Command palette & navigation

| DoD item | Status | Notes |
|----------|--------|-------|
| `<CommandPalette />` via `Cmd/Ctrl+K` — fuzzy search over labels, connectors, actions | ✅ | `CommandPalette.tsx` + `useCommandPalette`, wired into `GraphView` (commands: fit/reload/ingest/timeline/live/why; node jump); `localStorage` recents |
| Keyboard navigation: Tab/Shift+Tab focus nodes, Enter opens panel, Esc closes, Delete deletes, +/- zoom, Arrow pan | ⬜ | Full map in spec §7.7 |

### 3c · Timeline view

| DoD item | Status | Notes |
|----------|--------|-------|
| `<TimelineView />` — virtualized list, `createdAt` desc, date-range picker | ✅ | `TimelineView.tsx`, wired into `GraphView` (toolbar/palette toggle); click → select + centre node |

### 3d · Reasoning-path overlay (Jarvis explainability)

| DoD item | Status | Notes |
|----------|--------|-------|
| Invoke `POST /api/v1/brain/cortex/think` from graph context | 🟡 | `requestThink()` in `ReasoningPanel.tsx` + "Why this node?" palette command; response shape narrowed defensively pending the API endpoint |
| Render reasoning path (seeds → memory → association → conclusion) as highlighted edges on canvas | ✅ | `ReasoningPanel` phase trace; `onHighlightPath` rings nodes + `zoomToFit` on the path |
| Show confidence + proposed motor actions in side panel | ✅ | `ReasoningPanel` confidence bar + proposed motor actions |

> Also wired: **live updates** — `useGraphLiveUpdates` poll hook + a toolbar "Live" toggle merges `GET /public/graph/delta` results into the canvas in place.

### 3e · Quality gates

| DoD item | Status | Notes |
|----------|--------|-------|
| Lighthouse Performance ≥ 95 | ⬜ | CI job already gated on phase-3 config |
| All AC-F01 through AC-F14 pass (manual + automated checks) | ⬜ | |

## Phase 4 — Connector: GitHub (Week 8)

| DoD item | Status | Notes |
|----------|--------|-------|
| GitHub OAuth2 flow complete | ✅ | `OAuthService` + GitHub provider (PKCE); state now Postgres-backed (`oauth_states`) |
| Incremental sync via Events API | ✅ | `github.connector.ts` (cursor-based) |
| Connector transform unit tests: 95% coverage | 🟡 | `github.connector.spec.ts` (mocked HTTP); formal coverage gate pending |
| E2E journey 1: connect GitHub → view repos in graph | 🟡 | `api-e2e` CI job exercises the public ingest→snapshot round-trip on a live stack; OAuth-driven journey still manual |
| Sync scheduling production-ready (BullMQ, multi-instance) | ✅ | `sync.scheduler.ts` uses BullMQ job schedulers (Redis), graceful `setInterval` fallback (ADR-005) |

## Phase 5 — Connectors: Gmail + Google Calendar (Week 9)

| DoD item | Status | Notes |
|----------|--------|-------|
| Gmail OAuth2 + incremental sync (`historyId`) | ✅ | `gmail.connector.ts` — history delta + list fallback, quote-aware address parsing, rate-limit back-off |
| Google Calendar OAuth2 + incremental sync (`syncToken`) | ✅ | `google-calendar.connector.ts` |
| NLP pipeline stages 1–5 operational | 🟡 | per-connector mapping + `text-parser` heuristics; full NLP pipeline pending |
| Rate-limit handling with exponential back-off | ✅ | shared `readRateLimit` + per-connector header fallbacks (Rule 13) |

## Phase 6 — Connectors: Notion + Obsidian + Bookmarks (Week 10)

| DoD item | Status | Notes |
|----------|--------|-------|
| Notion OAuth2 + incremental sync | ✅ | `notion.connector.ts` |
| Obsidian ZIP upload + wikilink parsing | ✅ | `obsidian.connector.ts` (in-memory note list → notes + `[[wikilinks]]` + `#tags`); ZIP extraction at the upload boundary still TODO |
| Bookmark OPML/HTML import | ✅ | `bookmarks.connector.ts` (Netscape HTML + OPML, folders → `PART_OF`, tags → `TAGGED_WITH`) |
| Embedding generation (NLP stage 6) wired to Neo4j nodes | 🟡 | `ReasoningService.embed` exists; automatic on-ingest embedding pending |

## Phase 7 — Connectors: Outlook, Todoist, Linear, GitLab (Week 11)

| DoD item | Status | Notes |
|----------|--------|-------|
| All four connectors implemented and tested | ✅ | `outlook.connector.ts` (Graph delta), `todoist.connector.ts`, `linear.connector.ts` (GraphQL), `gitlab.connector.ts` (events API) — each with mocked-HTTP specs |
| All connector unit tests: 95% coverage | 🟡 | specs present for all connectors; formal coverage gate pending |
| Sync status dashboard in UI (progress bars, error messages) | ⬜ | `apps/web` connector roster shows status; richer dashboard pending |

> **Registry:** all 14 connectors (incl. real OpenAI/Anthropic/Pieces/Zotero replacing the earlier mock stubs) are registered in `ConnectorRegistry`/`ConnectorsModule` and resolvable by the sync orchestrator.

## Phase 8 — Hardening, Accessibility & Launch (Week 12)

| DoD item | Status | Notes |
|----------|--------|-------|
| WCAG 2.2 AA audit passes (axe-core + manual screen-reader test) | ⬜ | |
| GDPR delete + export endpoints tested with E2E tests | ⬜ | |
| k6 load test passes (p95 < 200 ms @ 200 concurrent users) | ⬜ | |
| Security review: OWASP Top 10 checklist complete | ⬜ | |
| Mutation score ≥ 70% on domain layer | ⬜ | |
| All 6 E2E user journeys green | 🟡 | `api-e2e` CI job boots the full stack and round-trips public ingest→snapshot; full journey suite pending |
| `docker compose up --build` produces fully working stack with seed data | 🟡 | Dockerfile + compose wiring added; run `docker compose up --build` then `pnpm stack:seed` |
| Architecture Decision Records written for all major choices | 🟡 | 10 ADRs already in `docs/adr/` |
| API documentation auto-generated (Swagger UI + GraphQL Playground) | 🟡 | Swagger wired; GraphQL Playground not yet gated |

---

## How to update

When you ship a PR that satisfies a DoD item:

1. Tick the row above (✅) and link the PR.
2. Update `apps/api/README.md` if a module's status changed.
3. If the work decided something architecturally significant, add an ADR under `docs/adr/` (Rule 6).
