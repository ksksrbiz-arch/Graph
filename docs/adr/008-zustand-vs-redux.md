# ADR-008: Zustand over Redux for frontend state

- Status: accepted
- Date: 2026-04-26
- Phase: 0 (chosen now; first used in Phase 3)

## Context

Frontend state breaks into:

- **Server state** (graph nodes, edges, search results) — handled by React Query / Apollo.
- **Client state** (selected node, viewport, filters, command-palette open?) — needs a store.

Redux Toolkit is ubiquitous but heavy on boilerplate; Jotai/Recoil are atom-based and over-engineered for our scope. Zustand is ~3 KB, plays nicely with React 18 Concurrent, and supports selectors out of the box.

## Decision

Zustand for client state. One store per concern (`useGraphStore`, `usePaletteStore`) instead of one mega-store.

## Consequences

- Devtools support exists but is less mature than Redux's. Trade-off accepted.
- Devs unfamiliar with Zustand: ~30 min to ramp.
