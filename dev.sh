#!/usr/bin/env bash
#
# dev.sh — Developer convenience wrapper for the Personal Knowledge Graph monorepo
#
# Usage:
#   ./dev.sh up          # docker compose up -d --wait (custom ports)
#   ./dev.sh down        # bring stack down
#   ./dev.sh seed        # pnpm stack:seed (builds + populates Neo4j)
#   ./dev.sh build       # build all workspace packages (reasoning, cortex, etc.)
#   ./dev.sh api         # start NestJS API in watch mode (http://localhost:3001/api/docs)
#   ./dev.sh web         # start Vite React client (http://localhost:3000)
#   ./dev.sh status      # show docker services + quick Neo4j counts
#   ./dev.sh pnpm ...    # run any pnpm command with correct PATH
#   ./dev.sh cypher      # open cypher-shell in the neo4j container
#
# The script ensures the correct pnpm 9.15.9 binary is on PATH (required because
# corepack is not in the base Node 18 image and we use a custom store location).
#

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PNPM_BIN="/home/getfuckeddude/.local/share/pnpm/.tools/pnpm/9.15.9/bin"

export PATH="$PNPM_BIN:$PATH"

# Color helpers
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log()  { echo -e "${GREEN}[dev]${NC} $*"; }
warn() { echo -e "${YELLOW}[dev]${NC} $*"; }
err()  { echo -e "${RED}[dev]${NC} $*"; }

need_pnpm() {
  if ! command -v pnpm >/dev/null 2>&1; then
    err "pnpm not found in PATH even after setting it."
    err "Make sure the path below exists:"
    err "  $PNPM_BIN/pnpm"
    exit 1
  fi
}

case "${1:-help}" in
  up)
    log "Starting docker stack (custom ports to avoid conflicts)..."
    docker compose up -d --wait
    log "Stack is healthy. Ports: Neo4j 7687/7474, Postgres 5433, Redis 6380, Meili 7701"
    ;;

  down)
    log "Stopping docker stack..."
    docker compose down
    ;;

  seed)
    need_pnpm
    log "Building workspace packages + seeding Neo4j (userId=local)..."
    pnpm --filter @pkg/shared build
    pnpm --filter @pkg/reasoning build
    pnpm --filter @pkg/cortex build
    pnpm --filter @pkg/spiking build
    pnpm stack:seed
    log "Seed complete. Run './dev.sh status' to inspect data."
    ;;

  build)
    need_pnpm
    log "Building all required workspace packages..."
    pnpm --filter @pkg/shared build
    pnpm --filter @pkg/reasoning build
    pnpm --filter @pkg/cortex build
    pnpm --filter @pkg/spiking build
    log "Build finished."
    ;;

  api)
    need_pnpm
    log "Starting NestJS API in watch mode..."
    log "Swagger: http://localhost:3001/api/docs"
    log "(Press Ctrl-C to stop)"
    pnpm --filter @pkg/api start:dev
    ;;

  web)
    need_pnpm
    log "Starting Vite React dev server..."
    log "App: http://localhost:3000"
    pnpm --filter @pkg/web dev
    ;;

  status)
    log "Docker services:"
    docker compose ps
    echo
    log "Quick Neo4j stats (local user):"
    docker compose exec -T neo4j cypher-shell -u neo4j -p password \
      "MATCH (n:KGNode {userId:'local'}) RETURN count(n) as nodes, count{ (n)-->() } as edges;" 2>/dev/null || true
    ;;

  cypher)
    log "Opening cypher-shell (bolt://localhost:7687, user neo4j / password)"
    docker compose exec -it neo4j cypher-shell -u neo4j -p password
    ;;

  pnpm)
    need_pnpm
    shift
    pnpm "$@"
    ;;

  help|*)
    echo "graph dev helper — available commands:"
    echo
    echo "  ./dev.sh up       — bring up the full data stack (Neo4j, Postgres, Redis, Meili)"
    echo "  ./dev.sh down     — stop the stack"
    echo "  ./dev.sh seed     — build workspace + populate Neo4j with mock data"
    echo "  ./dev.sh build    — build shared/reasoning/cortex/spiking"
    echo "  ./dev.sh api      — start the NestJS backend (watch mode)"
    echo "  ./dev.sh web      — start the Vite frontend"
    echo "  ./dev.sh status   — docker ps + quick graph counts"
    echo "  ./dev.sh cypher   — interactive cypher-shell against the running Neo4j"
    echo "  ./dev.sh pnpm ... — run any pnpm command with the correct pnpm version on PATH"
    echo
    echo "Typical first-time flow after clone:"
    echo "  ./dev.sh up && ./dev.sh seed && ./dev.sh api"
    echo
    ;;
esac
