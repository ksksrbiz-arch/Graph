# ADR-004: react-force-graph-2d as primary renderer

- Status: accepted
- Date: 2026-04-26
- Phase: 0

## Context

The performance budget (§4.1) is 60 fps @ 5k nodes desktop, 30 fps @ 5k nodes mobile. Pure SVG/D3 hits its ceiling around 1–2k nodes; we need WebGL/Canvas.

Options:

1. **D3-force + custom Canvas** — most control, most code to maintain.
2. **Cytoscape.js** — mature, but heavier API, less idiomatic React.
3. **Sigma.js** — fast WebGL, but custom layout pipeline.
4. **react-force-graph-2d / -3d** — wraps `force-graph` (Canvas) and `3d-force-graph` (WebGL). Tiny React surface, runs simulations on a worker, supports our acceptance criteria (AC-F01–F14).

## Decision

`react-force-graph-2d` is the primary renderer; `-3d` is a user-toggleable option for power users (per §3.3 table). The renderer sits behind a `<GraphRenderer />` abstraction so the library is swappable.

## Consequences

- Tightly couples to a single maintainer's library; mitigation: thin abstraction (Risk Register entry).
- Bundle cost: ~120 KB gzipped — fits within the 500 KB budget (Rule 22).
