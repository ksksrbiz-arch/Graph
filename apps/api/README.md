# @pkg/api

PKG-VS API server — NestJS 10 (REST + GraphQL + WebSocket). Implements the contract in spec §6 and the module structure in §8.1.

## Phase 0 status

| Module        | State                                               |
| ------------- | --------------------------------------------------- |
| `health`      | ✅ live + ready (Neo4j check)                        |
| `shared/crypto` | ✅ AES-256-GCM credential cipher (ADR-006)          |
| `shared/neo4j`  | ✅ driver provider (host-side env)                  |
| `auth`        | 🟡 JWT skeleton — login throws 401 until Phase 1     |
| `graph`       | 🟡 repository + subgraph endpoint, no GraphQL yet    |
| `users`       | ⬜ Phase 1                                           |
| `audit`       | ⬜ Phase 1 (table & RLS already in `infra/postgres/init`) |
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

## Tests

```bash
pnpm --filter @pkg/api test           # unit
pnpm --filter @pkg/api test:cov       # with coverage report
pnpm --filter @pkg/api test:mutation  # Stryker (Rule 23)
```
