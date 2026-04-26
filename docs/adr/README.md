# Architecture Decision Records

One file per significant decision. Every decision recorded as a separate ADR (Rule 6) so the *why* survives staff turnover. New ADRs use `000-template.md` as a starting point.

| #   | Title                                                                  | Status   |
| --- | ---------------------------------------------------------------------- | -------- |
| 001 | [Monorepo structure with pnpm workspaces](001-monorepo-pnpm.md)        | accepted |
| 002 | [NestJS over plain Express for the API layer](002-nestjs-vs-express.md) | accepted |
| 003 | [Neo4j as the primary graph store](003-neo4j-primary-store.md)         | accepted |
| 004 | [react-force-graph-2d as primary renderer](004-react-force-graph.md)   | accepted |
| 005 | [BullMQ for sync scheduling](005-bullmq-scheduling.md)                 | accepted |
| 006 | [AES-256-GCM with per-user DEKs for credentials](006-aes-gcm-deks.md)  | accepted |
| 007 | [Cursor-based pagination](007-cursor-pagination.md)                    | accepted |
| 008 | [Zustand over Redux for frontend state](008-zustand-vs-redux.md)       | accepted |
| 009 | [Meilisearch over Elasticsearch](009-meilisearch-vs-elastic.md)        | accepted |
| 010 | [In-process MiniLM embeddings over OpenAI API](010-minilm-vs-openai.md) | accepted |
