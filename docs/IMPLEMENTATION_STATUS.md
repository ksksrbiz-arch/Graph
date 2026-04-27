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
| JWT authentication (login, refresh, logout)           | 🟡 | Strategy + module wired; login throws 401 |
| OAuth2 integration scaffold                           | ⬜ | |
| User table in PostgreSQL; profile CRUD                | 🟡 | Table in `infra/postgres/init/001-schema.sql`; CRUD pending |
| Audit log table + middleware wired                    | 🟡 | Table + immutability rules in place; interceptor pending |
| Unit tests: 90% coverage on auth module               | ⬜ | |

## Phase 2 — Graph Core (Week 4–5)

| DoD item                                                | Status | Notes |
| ------------------------------------------------------- | ------ | ----- |
| Neo4j connection provider + repository pattern          | ✅ | |
| REST + GraphQL endpoints for nodes/edges/subgraph       | 🟡 | REST `/subgraph` and `DELETE /nodes/:id` only; GraphQL pending |
| Meilisearch node indexing + search endpoint             | ⬜ | |
| WebSocket gateway (Socket.IO) for `graph:delta` events  | ⬜ | |
| Unit + integration tests for graph repository           | 🟡 | Service-level mock tests; integration tests pending |

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
