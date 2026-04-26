# ADR-010: In-process MiniLM embeddings over OpenAI embeddings API

- Status: accepted
- Date: 2026-04-26
- Phase: 0 (decided now; first used in Phase 6)

## Context

Spec §9.3 stage 6 generates 384-dimensional embeddings for semantic search. Options:

1. **OpenAI `text-embedding-3-small`** — high quality, 1536-dim, costs money, sends user content to a third party.
2. **`all-MiniLM-L6-v2` via `@xenova/transformers`** — runs in-process via ONNX, 384-dim, no network, no per-token cost.

Rule 25 (Ethical AI guard) explicitly says we must not store raw email/document content beyond what's needed for entity extraction — sending it to OpenAI is also a privacy concern.

## Decision

`all-MiniLM-L6-v2` via `@xenova/transformers`. Embeddings live in Neo4j as `KGNode.embedding` (length 384, validated by zod).

## Consequences

- API container needs ~150 MB extra RAM for the model. Acceptable.
- Cold-start adds ~2 s for model download on first run; cached afterward.
- Quality is lower than OpenAI's but sufficient for cosine-similarity neighbour suggestions.
- If a deployer prefers OpenAI, an abstraction (`EmbeddingProvider`) makes the swap one-file.
