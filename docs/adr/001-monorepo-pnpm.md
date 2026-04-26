# ADR-001: Monorepo structure with pnpm workspaces

- Status: accepted
- Date: 2026-04-26
- Phase: 0

## Context

PKG-VS ships a frontend (`apps/web`), an API (`apps/api`), and a shared types package (`packages/shared`). The frontend and API both import the canonical `KGNode` / `KGEdge` types and zod schemas, so they need a single source of truth that's editable in one place and re-published atomically across packages.

Options considered:

1. **Multi-repo + npm publish** for the shared package — cumbersome local dev (publish on every type change).
2. **Yarn 3 / Berry workspaces** — capable but workspace protocols and PnP introduce friction with NestJS and Vite.
3. **Nx / Turborepo full monorepo** — overkill for three packages; brings caching/build-graph machinery we don't yet need.
4. **pnpm workspaces** — fast install, hard-link disk savings, native `workspace:*` protocol, no build orchestrator dependency.

## Decision

Adopt pnpm workspaces. Top-level `pnpm-workspace.yaml` covers `apps/*` and `packages/*`. Cross-workspace deps use `workspace:*`.

## Consequences

- Contributors must install pnpm (`corepack enable && corepack use pnpm@9` works on Node 18+).
- CI cache key uses `pnpm-lock.yaml`; matrix builds reuse install layers.
- Migration to Turborepo possible later without code changes — we'd just gain a task graph.
