# ADR-003: Neo4j as the primary graph store

- Status: accepted
- Date: 2026-04-26
- Phase: 0

## Context

The product is a knowledge graph; the dominant query is "fetch the ego-network of node X to depth N." Options:

1. **Postgres + recursive CTEs** — workable up to ~1k-node neighbourhoods, painful past that, and graph DSL is awkward.
2. **JanusGraph / DGraph** — more operational complexity than we want for a single-user-by-default product.
3. **Neo4j Community 5** — native graph storage, Cypher is purpose-built for the patterns in §8.2, mature drivers, free for self-hosted single-instance.

## Decision

Neo4j 5 Community as the primary store for nodes/edges. Postgres remains for users, audit, connector config (relational, transactional, no graph traversal).

## Consequences

- Two databases to operate. Acceptable: each does what it's good at.
- Reliance on Cypher; `GraphRepository` is the only place Cypher exists, so swapping later (e.g. to Postgres + Apache AGE) only touches one file.
- License: Community Edition is GPL-3 — fine for SaaS deployment behind our API.
