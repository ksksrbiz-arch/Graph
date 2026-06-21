# @pkg/api

PKG-VS API server — NestJS 10 (REST + GraphQL + WebSocket). Implements the contract in spec §6 and the module structure in §8.1.

## Module status

See [`docs/IMPLEMENTATION_STATUS.md`](../../docs/IMPLEMENTATION_STATUS.md) for the authoritative, phase-by-phase view.

| Module        | State                                               |
| ------------- | --------------------------------------------------- |
| `health`      | ✅ live + ready (Neo4j, Postgres, Redis, Meilisearch checks) |
| `shared/crypto` | ✅ AES-256-GCM credential cipher (ADR-006)          |
| `shared/neo4j`  | ✅ driver provider                                  |
| `shared/meilisearch` | ✅ node indexing + search                      |
| `auth`        | ✅ register / login / refresh / logout; bcrypt + token rotation |
| `users`       | ✅ `GET/PATCH/DELETE /users/me`; Postgres-backed    |
| `audit`       | ✅ `AuditService` + global `AuditInterceptor`       |
| `graph`       | ✅ REST (nodes/subgraph/search/delete) + GraphQL (Apollo, code-first) + Socket.IO `graph:delta` gateway |
| `brain`       | ✅ spiking runtime, checkpoints, sensory perceive, attention, dreams, recall, deterministic cortex pipeline |
| `motor`       | ✅ safety supervisor (denylist + rate-limit + approval); `POST /motor/evaluate`, `GET /motor/recent` |
| `reasoning` / `agent` / `arc` | ✅ reasoning + agent permission/execution + arc endpoints |
| `oauth`       | ✅ OAuth2 scaffold (GitHub, Google Calendar, Notion) with PKCE; in-memory config store |
| `public`      | ✅ anonymous `POST /api/v1/public/ingest/{text,markdown,url}` + `GET /api/v1/public/graph` (powers the hosted demo) |
| `connectors`  | ⬜ Phases 4–7 — `BaseConnector` contract frozen      |
| `sync`        | ⬜ Phase 4 (BullMQ)                                  |

## Quick start

```bash
# 0. From repo root, bring up data services
pnpm stack:up

# 1. Install (will resolve workspace:* deps)
pnpm install

# 2. Run dev server
pnpm --filter @pkg/api start:dev
```

Swagger UI: http://localhost:3001/api/docs

## Hosted runtime

- Use `apps/api/Dockerfile` for production container builds.
- `/health` is liveness-only; `/health/ready` now checks Neo4j, Postgres, Redis, and Meilisearch connectivity.
- `BRAIN_AUTO_START_USER_IDS` lets the API resume selected user brains on boot.
- `BRAIN_AUTO_START_DREAM`, `BRAIN_DEFAULT_AWAKE_MS`, and `BRAIN_DEFAULT_DREAM_MS` control the always-on wake/sleep cycle.
- Redis owns the singleton runtime lock so only one API instance runs a given brain at a time.
- `API_PUBLIC_URL` is used for OAuth callback generation, and `CORS_ORIGINS` gates browser + Socket.IO access from the separately hosted web app.

## Tests

```bash
pnpm --filter @pkg/api test           # unit
pnpm --filter @pkg/api test:cov       # with coverage report
pnpm --filter @pkg/api test:mutation  # Stryker (Rule 23)
```
