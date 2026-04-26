FROM node:20-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
COPY packages/cortex/package.json packages/cortex/
COPY packages/reasoning/package.json packages/reasoning/
COPY packages/spiking/package.json packages/spiking/
RUN pnpm install --frozen-lockfile

FROM node:20-alpine AS build
WORKDIR /app
RUN corepack enable
COPY --from=deps /app /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
COPY packages/cortex/package.json packages/cortex/
COPY packages/reasoning/package.json packages/reasoning/
COPY packages/spiking/package.json packages/spiking/
COPY packages/shared packages/shared
COPY packages/cortex packages/cortex
COPY packages/reasoning packages/reasoning
COPY packages/spiking packages/spiking
COPY apps/api apps/api
RUN pnpm -r --filter "./packages/*" run build && pnpm --filter @pkg/api build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/package.json apps/api/
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/cortex/dist packages/cortex/dist
COPY --from=build /app/packages/cortex/package.json packages/cortex/
COPY --from=build /app/packages/reasoning/dist packages/reasoning/dist
COPY --from=build /app/packages/reasoning/package.json packages/reasoning/
COPY --from=build /app/packages/spiking/dist packages/spiking/dist
COPY --from=build /app/packages/spiking/package.json packages/spiking/
COPY --from=build /app/node_modules node_modules
EXPOSE 3001
CMD ["node", "apps/api/dist/main.js"]
