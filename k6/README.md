# k6 Load Tests

Performance load tests for the Graph PKG-VS API targeting p95 < 200ms at 150 concurrent VUs.

## Prerequisites

Install k6:

```bash
# macOS
brew install k6

# Windows
choco install k6

# Linux (Debian/Ubuntu)
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
  --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
  | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6
```

## Running

```bash
# Run all scenarios against local dev server (default: http://localhost:3001)
k6 run k6/load-test.js

# Run against a custom URL
BASE_URL=https://api.example.com k6 run k6/load-test.js
```

An HTML report is written to `k6/summary.html` after each run.

## Scenarios

Each scenario runs 50 VUs for 60 seconds via its own named export function (k6 `exec`):

| Scenario | VUs | Duration | Endpoint |
|---|---|---|---|
| `health_check` | 50 | 60s | `GET /health` |
| `public_ingest_health` | 50 | 60s | `GET /api/v1/public/ingest/health` |
| `graph_snapshot` | 50 | 60s | `GET /api/v1/public/graph?userId=local` |

All three scenarios run concurrently (150 VUs total).

## Thresholds

- **p95 latency < 200ms** per scenario: 95% of requests for each endpoint must complete under 200ms.
- **Error rate < 1%**: fewer than 1% of total requests may fail (non-2xx or network error).

Thresholds are enforced per-scenario via tag scoping so a slow endpoint cannot be masked by a fast one.

## Notes

- The `public_ingest_health` and `graph_snapshot` endpoints have a server-side rate limit of
  30 req/min per IP. Under sustained load, some VUs will receive `429 Too Many Requests`
  responses, which count as failures. Run against a local dev instance (default) to avoid this.
- Ensure Neo4j is seeded (`pnpm stack:seed`) before running `graph_snapshot` — an unseeded
  database returns an empty but valid 200 response.
