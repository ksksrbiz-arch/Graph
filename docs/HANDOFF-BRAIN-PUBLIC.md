# Handoff — Server-side brain on the public deploy

Goal: get the v2 NestJS brain api reachable from `graph.skdev-371.workers.dev` so the canvas pulls real spike events over Socket.IO instead of running the in-browser fallback. Persistent STDP weights, single source of truth across viewers, no laptop dependency.

## Decision: managed services + Fly.io for the api

| Layer | Choice | Why |
|---|---|---|
| API runtime | **Fly.io** (free hobby app) | Docker-native, TLS terminates at edge, healthchecks built in, free tier handles this load |
| Graph DB | **Neo4j AuraDB Free** | 200k nodes / 400k edges cap fits 823n/2112e × 100, zero ops, free forever, managed backups |
| Postgres | **Supabase Free** (you already use it for UnifyOne) | One project, free tier, free pooler. Or Fly Postgres if you want everything on Fly |
| Redis | **Upstash Free** | 10k commands/day = enough for BullMQ + token revocation, edge-distributed |
| Meilisearch | **skip for v1** | API already falls back to Neo4j fulltext when Meili is unreachable |

Cost: **$0** at this scale. Custom domain optional ($10/yr + free SSL).

Alternative one-liner: if you'd rather not split, swap Neo4j AuraDB for Fly + persistent volume (~$3/mo).

---

## Phase 1 — Provision external services (do this manually first, ~10 min)

These create the URLs/credentials Phase 2's secrets command needs.

### 1.1 Neo4j AuraDB Free
1. <https://console.neo4j.io/> → "New instance" → AuraDB Free → name `pkg-graph-prod`
2. Save the generated password and the **Connection URI** (looks like `neo4j+s://abc123.databases.neo4j.io`)
3. Wait ~60 sec for the instance to spin up

### 1.2 Supabase Postgres
1. <https://supabase.com/dashboard> → New project → name `pkg-vs`
2. Settings → Database → Connection string → **Transaction pooler** (port 6543) — copy this for `POSTGRES_URL`
3. Run `infra/postgres/init/*.sql` from the repo against it via the Supabase SQL editor (creates `users`, `connectors`, `audit_log`)

### 1.3 Upstash Redis
1. <https://console.upstash.com/redis> → Create database → name `pkg-redis` → Free tier, region nearest your Fly region
2. Copy the **Connect URL** (looks like `rediss://default:...@us1-foo.upstash.io:6379`)

### 1.4 Fly.io account + CLI
```bash
brew install flyctl                    # mac
# or: curl -L https://fly.io/install.sh | sh
fly auth signup                        # or: fly auth login
```

---

## Phase 2 — Repo prep (Claude Code does this)

Single PR. All file paths relative to the cloned repo at `~/repos/graph`.

### 2.1 `apps/api/Dockerfile` (new) — production NestJS image

```dockerfile
# syntax=docker/dockerfile:1.7
FROM node:20-alpine AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9 --activate
# Copy lockfiles + workspace package.jsons so we get the same install in CI + Fly
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json ./apps/api/
COPY packages/shared/package.json ./packages/shared/
COPY packages/spiking/package.json ./packages/spiking/
COPY packages/cortex/package.json ./packages/cortex/
COPY packages/reasoning/package.json ./packages/reasoning/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm --filter @pkg/shared build \
 && pnpm --filter @pkg/spiking build \
 && pnpm --filter @pkg/cortex build \
 && pnpm --filter @pkg/reasoning build \
 && pnpm --filter @pkg/api build

FROM node:20-alpine AS runtime
ENV NODE_ENV=production PORT=8080
WORKDIR /app
RUN apk add --no-cache tini
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/api/dist ./dist
COPY --from=build /app/apps/api/package.json ./
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=4s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
```

### 2.2 `fly.toml` (new, repo root)

```toml
app = "pkg-brain"          # change if taken; fly suggests an alternative
primary_region = "sjc"      # pick the one nearest your Neo4j Aura region

[build]
  dockerfile = "apps/api/Dockerfile"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 0      # scales to 0 when idle — set to 1 if you need always-on brain ticks
  processes = ["app"]

[[http_service.checks]]
  type = "http"
  method = "get"
  path = "/health"
  interval = "30s"
  timeout = "4s"
  grace_period = "20s"

[deploy]
  release_command = "node dist/scripts/run-migrations.js"   # only if you add one; otherwise omit

[env]
  NODE_ENV = "production"
  PORT = "8080"
  CORS_ORIGINS = "https://graph.skdev-371.workers.dev"
  LOG_LEVEL = "info"
  # All other config comes via `fly secrets set`

[[vm]]
  cpu_kind = "shared"
  cpus = 1
  memory_mb = 512
```

> **Important:** `min_machines_running = 0` saves money but means the brain sim resets each cold start. If you want continuous STDP learning, set it to `1` (still free tier as long as you don't exceed CPU minutes).

### 2.3 `apps/api/src/main.ts` — ensure CORS reads the env

Verify the current bootstrap binds 0.0.0.0 and reads PORT/CORS:
```ts
app.enableCors({
  origin: (process.env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  credentials: true,
});
const port = Number(process.env.PORT ?? 3001);
await app.listen(port, '0.0.0.0');
```

Adjust if not already this shape.

### 2.4 New script: `scripts/import-to-neo4j.mjs` (already exists, verify it's connection-string-aware)

It already reads `NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD` from env. No changes needed.

### 2.5 v1 client — make the brain api URL configurable

**`web/index.html`** — add a configurable meta tag right after the `build-id` one:
```html
<meta name="brain-api-url" content="https://pkg-brain.fly.dev" />
```
(Empty content = use local fallback. Set the value when deploying.)

**`web/brain.js`** — read it before the static-host check:
```js
function configuredBrainUrl() {
  if (typeof document === 'undefined') return null;
  const meta = document.querySelector('meta[name=brain-api-url]');
  const url = meta?.content?.trim();
  return url && /^https?:\/\//.test(url) ? url : null;
}

function looksLikeStaticHost() {
  if (typeof window === 'undefined') return true;
  if (configuredBrainUrl()) return false;   // explicit override wins
  const h = window.location.hostname || '';
  if (h === 'localhost' || h === '127.0.0.1' || h.endsWith('.local')) return false;
  return ['.workers.dev', '.pages.dev', '.github.io'].some((s) => h.endsWith(s));
}

// Inside tryConnectSocket():
const url = (configuredBrainUrl() ?? window.location.origin) + '/brain';
```

### 2.6 Commit + open PR

```bash
git checkout -B claude/deploy-brain-fly
git add apps/api/Dockerfile fly.toml apps/api/src/main.ts web/brain.js web/index.html
git commit -m "feat(deploy): production Dockerfile + fly.toml + configurable brain api url

- apps/api/Dockerfile: multi-stage pnpm workspace build, listens on :8080
- fly.toml: scale-to-zero by default, /health probe, CORS via env
- web/brain.js: configurable brain-api-url meta tag overrides static-host
  short-circuit so the deployed worker can point at any public api"
git push -u origin claude/deploy-brain-fly
gh pr create --fill --base main
```

---

## Phase 3 — Set Fly secrets + deploy api (Claude Code does this)

```bash
cd ~/repos/graph

# Create the app (use your --org if you have multiple)
fly launch --no-deploy --copy-config --name pkg-brain --region sjc

# All secrets from Phase 1 + new ones
fly secrets set \
  NEO4J_URI='neo4j+s://abc123.databases.neo4j.io' \
  NEO4J_USER='neo4j' \
  NEO4J_PASSWORD='<from Aura console>' \
  POSTGRES_URL='postgresql://postgres.<...>:6543/postgres?pgbouncer=true' \
  REDIS_URL='rediss://default:...@us1-foo.upstash.io:6379' \
  JWT_SECRET="$(openssl rand -base64 48)" \
  JWT_ACCESS_TTL='900' \
  JWT_REFRESH_TTL='2592000' \
  KEK_BASE64="$(openssl rand -base64 32)"

# First deploy
fly deploy

# Verify
fly logs       # watch boot — should see "[api] listening on http://0.0.0.0:8080"
curl -s https://pkg-brain.fly.dev/health
# expect: {"status":"ok","uptime":<seconds>}

curl -s https://pkg-brain.fly.dev/health/ready | jq
# expect: neo4j ok, postgres ok, redis ok
```

If anything reports `down` in `/health/ready`, fix the corresponding secret and `fly deploy` again.

---

## Phase 4 — Seed the public Neo4j (Claude Code does this)

```bash
cd ~/repos/graph

# Re-run the latest ingest into data/graph.json (already auto-mirrors to web/data)
npm run ingest:claude-code

# Bulk-import into the AURA Neo4j (uses the same script that already works locally)
NEO4J_URI='neo4j+s://abc123.databases.neo4j.io' \
NEO4J_USER='neo4j' \
NEO4J_PASSWORD='<from Aura console>' \
  node scripts/import-to-neo4j.mjs

# expect: "[import] Neo4j: 823 nodes · 2112 edges"

# Boot the brain on the deployed api
TOKEN=$(curl -s -X POST https://pkg-brain.fly.dev/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@example.com","password":"demodemo"}' \
  | jq -r '.accessToken')

curl -s -X POST https://pkg-brain.fly.dev/api/v1/brain/start \
  -H "Authorization: Bearer $TOKEN"
# expect: {"neurons":823,"synapses":2112}
```

If the demo user isn't seeded in Supabase, run `infra/postgres/init/*.sql` against it first (Phase 1.2 should have done this).

---

## Phase 5 — Wire the v1 worker at the public api (Claude Code does this)

```bash
cd ~/repos/graph

# Stamp the production API URL into the deployed shell
sed -i 's|<meta name="brain-api-url" content=""|<meta name="brain-api-url" content="https://pkg-brain.fly.dev"|' web/index.html

git add web/index.html
git commit -m "chore(deploy): point web client at production brain api"
git push

# Re-deploy the worker
npx wrangler deploy

# Verify
curl -s https://graph.skdev-371.workers.dev/ | grep brain-api-url
# expect: <meta name="brain-api-url" content="https://pkg-brain.fly.dev" />
```

---

## Phase 6 — Verify end-to-end (Claude Code does this)

```bash
# 1) Public worker serves data
curl -sI https://graph.skdev-371.workers.dev/data/graph.json
# expect: HTTP/2 200, content-type: application/json

# 2) Public brain api healthy
curl -s https://pkg-brain.fly.dev/health/ready | jq

# 3) Brain status
curl -s https://pkg-brain.fly.dev/api/v1/brain/status -H "Authorization: Bearer $TOKEN"
# expect: {"running":true,"neurons":823,"synapses":2112,"tMs":<positive>}

# 4) Socket.IO tap from outside
HOST=https://pkg-brain.fly.dev USER_ID=00000000-0000-4000-8000-000000000001 SECONDS=4 npm run sniff:brain
# expect: > 1000 spikes, regions populated, weight changes > 0
```

In a browser:
- Open https://graph.skdev-371.workers.dev/ in incognito
- DevTools → Console should show `[brain] connected wss://pkg-brain.fly.dev/brain` (no static-host fallback)
- Spike halos should pulse on nodes
- DevTools → Network → filter `/brain/socket.io/` → see WebSocket frames flowing

---

## Phase 7 — Optional polish

### 7.1 Custom domain
```bash
fly certs add brain.1commercesolutions.com
# follow the DNS instructions Fly prints; CNAME → pkg-brain.fly.dev
```
Then update `web/index.html` to `<meta name="brain-api-url" content="https://brain.1commercesolutions.com" />` and re-deploy worker.

### 7.2 Always-on brain (paid)
If `min_machines_running = 0` is causing cold starts you don't want, bump to `1` in `fly.toml` and `fly deploy`. Fly will keep one instance warm. Adds ~$2-3/mo but means STDP learning is continuous + every visitor sees the same brain state.

### 7.3 Auto-checkpoint hot-restart
Already baked in — `BrainService.checkpoint()` runs every 5 min and on `onModuleDestroy`. So even cold-starts retain learned weights (they're persisted to Neo4j Aura which survives restarts).

### 7.4 Connector → sensory pipeline (real-data flow)
Phase 1+ work outside this handoff. When connectors land (gmail, github, …), each new node fires `SensoryService.perceive(userId, node)` which injects current into the matching neuron. The brain *literally* starts thinking when you get an email.

---

## Final cleanup

```bash
git status                    # should be clean
git log --oneline -5
gh pr list --state open       # should be empty if all merged

# Tag the release
git tag -a v0.2-brain-public -m "Server-side brain live at pkg-brain.fly.dev"
git push origin v0.2-brain-public
```

---

## Risk register / known gotchas

| Risk | Mitigation |
|---|---|
| Aura Free quota: 200k nodes / 400k edges | At 823n/2112e you're 0.4% / 0.5% utilized. Fine for years. Upgrade to Aura Professional ($65/mo) when needed. |
| Fly free tier limits | 3 shared-cpu-1x machines, 160GB egress/mo. The api uses 1. WebSocket bandwidth at 800Hz × 64-byte spikes × 5 viewers ≈ 60MB/hr. Stays well under. |
| Cold starts (scale to zero) | First request after idle takes 3-5s. Keep `min_machines_running = 1` if this matters. |
| JWT secret rotation | Set a calendar reminder for 6 months. `fly secrets set JWT_SECRET="$(openssl rand -base64 48)"` invalidates all sessions. |
| Neo4j password leakage | Aura passwords can't be retrieved after creation — store in a password manager AND in Fly secrets. |
| CORS misconfig | If `Origin not allowed` shows in Fly logs, double-check `CORS_ORIGINS` matches your worker URL exactly (no trailing slash). |
| Multi-tenant brain state in single user_id namespace | Phase 0 — every visitor shares the same simulator. Acceptable for "neural interface to my own data" framing. Phase 1+ partitions per real user. |

---

## What this gets you

**Before:** local-only brain. Closes when laptop sleeps. Each browser viewer runs a separate in-memory simulator with no persistence. Spike halos animate but they're a stage prop.

**After:** one brain in the cloud, ticking 24/7, learning STDP weights that persist to Neo4j Aura between restarts, broadcasting spike events over WebSocket to every connected viewer in real-time. The same brain you stimulate from your phone is the brain your laptop sees, is the brain a friend sees if you share the URL.

Deployment cost: **$0/mo** at current scale. Engineering time: **~1 hour** for someone fresh, ~30 min for Claude Code.
