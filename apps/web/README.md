# `@pkg/web` — React 18 client (Phase 0+ scaffold)

Phase 0 ships the scaffolding so the rest of the monorepo can declare a stable
target (CI gates lint + type-check on this package being valid). The full
canvas migration (react-force-graph, command palette, keyboard shortcuts) is
queued for Phase 3.

Until Phase 3 lands, the live demo continues to serve from the v1 static
viewer at [`/web`](../../web). That deploy already pulls the live brain off
the Fly.io API and lets visitors paste-ingest text directly from the page.

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
