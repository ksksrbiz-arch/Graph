# syntax=docker/dockerfile:1.7
FROM node:20-alpine AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9 --activate
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json ./apps/api/
COPY packages/shared/package.json ./packages/shared/
COPY packages/spiking/package.json ./packages/spiking/
COPY packages/cortex/package.json ./packages/cortex/
COPY packages/reasoning/package.json ./packages/reasoning/
RUN pnpm install --no-frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm --filter @pkg/shared build && \
    pnpm --filter @pkg/spiking build && \
    pnpm --filter @pkg/cortex build && \
    pnpm --filter @pkg/reasoning build && \
    pnpm --filter @pkg/api build

# Runtime: keep the same layout pnpm produced — symlinks need their
# relative paths intact. Run from /app/apps/api so the resolver finds
# both the local node_modules + the workspace-hoisted .pnpm store.
FROM node:20-alpine AS runtime
ENV NODE_ENV=production PORT=8080
WORKDIR /app
RUN apk add --no-cache tini wget
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/api ./apps/api
WORKDIR /app/apps/api
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=4s --start-period=30s \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
