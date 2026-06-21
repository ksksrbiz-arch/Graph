# `@pkg/web` — React 18 client (Phase 3)

The spec-grade, API-driven graph canvas (Phase 3) now lives here under
[`src/graph/`](src/graph). It renders the personal knowledge graph with
`react-force-graph-2d` and ships the core canvas interactions (spec §7.2):

- Force-directed canvas; node colour by `NodeType` (12-hue palette from
  `@pkg/shared`), node size by degree.
- Hover tooltip + neighbour dimming, click side panel (metadata + in/out
  edges), double-click ego-network focus (`GET /graph/subgraph`).
- Right-click context menu, Shift+Click multi-select + bulk delete, client-side
  type filter panel, search, fit-to-screen (`F`).

Data loads from `GET /api/v1/public/graph` using Phase-0 anon mode
(`?userId=local`), so no login is required in dev. Remaining Phase-3 work
(minimap, command palette, timeline, reasoning overlay, perf benchmarks) is
tracked in [`docs/IMPLEMENTATION_STATUS.md`](../../docs/IMPLEMENTATION_STATUS.md).

The v1 static viewer at [`/web`](../../web) still serves the public demo until
this client is deployed in its place.

## Local dev

```bash
pnpm install                    # one-time, from repo root
pnpm --filter @pkg/web dev      # http://localhost:3000
```

The Vite dev server proxies `/api/*` to `VITE_API_URL` (default
`http://localhost:3001`). Set it to a hosted brain URL for remote testing:

```bash
VITE_API_URL=https://pkg-brain-9909.fly.dev pnpm --filter @pkg/web dev
```

## Build

```bash
pnpm --filter @pkg/web build    # → apps/web/dist
```
