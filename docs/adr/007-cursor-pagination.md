# ADR-007: Cursor-based pagination over offset pagination

- Status: accepted
- Date: 2026-04-26
- Phase: 0

## Context

Spec §6 lists multiple list endpoints (`/graph/nodes`, `/audit-log`, …). Offset pagination has well-known issues:

- Skips/duplicates when items are added/removed during traversal.
- Performance degrades on large offsets (`OFFSET 100000`).
- Doesn't fit Neo4j paths well.

## Decision

Cursor-based pagination everywhere (Rule 17). The cursor is an opaque base64 string encoding either:

- A `(createdAt, id)` tuple for time-ordered lists, or
- A Neo4j skip-token for graph traversals.

Response shape: `{ items: T[], nextCursor: string | null }`.

## Consequences

- Frontend cannot jump to "page N." Acceptable: virtualized lists/infinite scroll fit the UX better.
- Backend must encode/decode cursors consistently — helper module ships in Phase 2.
