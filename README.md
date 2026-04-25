# Graph — Personal Knowledge Graph Visualization System

A web application that ingests a user's digital footprint and renders it as an interactive force-directed graph, enabling visual navigation of personal knowledge networks.

## Documentation

- **[Enhanced Specification v2.0](docs/enhanced-personal-knowledge-graph-prompt.md)** — Full production-ready engineering specification including data schemas, API contract, connector specs, security model, 8-phase roadmap, and AI agent instructions.

## Quick Start

```bash
# Bring up all services (Neo4j, PostgreSQL, Redis, Meilisearch, API, Web)
docker compose up --build
```

The web UI will be available at `http://localhost:3000` and the API at `http://localhost:3001`.

## Architecture

- **Frontend:** React 18 + react-force-graph-2d + Zustand + Radix UI
- **Backend:** NestJS 10 + GraphQL + REST + WebSocket (Socket.IO)
- **Graph DB:** Neo4j 5
- **Relational DB:** PostgreSQL 15
- **Cache / Queue:** Redis 7 + BullMQ
- **Search:** Meilisearch

See the [full specification](docs/enhanced-personal-knowledge-graph-prompt.md) for complete architecture details, data schemas, API contracts, connector specs, security model, and implementation roadmap.