# ADR-002: NestJS over plain Express for the API layer

- Status: accepted
- Date: 2026-04-26
- Phase: 0

## Context

Spec §6 demands REST + GraphQL + WebSocket from day one, plus typed configuration, JWT guards, Swagger generation, throttling, and DI. Hand-rolling those concerns on Express produces a fragile pile of middleware; the alternatives were Fastify-with-handcoded-DI or Nest.

## Decision

NestJS 10. Reasons:

- First-class GraphQL via `@nestjs/graphql` + Apollo, no glue.
- Guards/Pipes pattern matches our auth/validation requirements (§10).
- Swagger module auto-generates docs from controllers (Rule 7 alignment).
- WebSocket gateway integrates Socket.IO without a parallel server.
- Strong testability (`Test.createTestingModule`) — required by Rule 2 (TDD).

## Consequences

- Slightly heavier cold-start than bare Express; not material for a stateful API.
- Learning curve for contributors new to decorators / Angular-style DI; mitigated by ADRs and the §8.1 module map.
