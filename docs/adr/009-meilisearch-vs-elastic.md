# ADR-009: Meilisearch over Elasticsearch for node full-text search

- Status: accepted
- Date: 2026-04-26
- Phase: 0

## Context

Full-text search across labels + metadata (§7 search view). Elasticsearch is the default heavyweight; Meilisearch is a Rust-native engine optimised for typo-tolerant instant search.

## Decision

Meilisearch v1.6. Reasons:

- 1-binary deploy, ~50 MB RAM idle (vs Elasticsearch's GB-class footprint).
- Out-of-the-box typo tolerance, prefix search, and faceting — covers AC for the search view.
- Simple JSON API; no DSL learning curve.
- Self-hosted in Docker like everything else in the stack.

## Consequences

- Less operational tooling than Elasticsearch's ecosystem (no Kibana). Acceptable for our query patterns.
- If we ever need cross-cluster replication or vector search at scale, revisit; Phase 6 already plans MiniLM embeddings stored in Neo4j (vector index) rather than Meilisearch.
