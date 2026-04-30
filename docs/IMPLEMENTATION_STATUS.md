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

## Phases 3–8

⬜ Not started. Tracked here for visibility; do not rush these — each phase has its own DoD in §12 of the spec.

---

## How to update

When you ship a PR that satisfies a DoD item:

1. Tick the row above (✅) and link the PR.
2. Update `apps/api/README.md` if a module's status changed.
3. If the work decided something architecturally significant, add an ADR under `docs/adr/` (Rule 6).
