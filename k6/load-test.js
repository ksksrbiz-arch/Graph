import http from 'k6/http';
import { check, sleep } from 'k6';
import { htmlReport } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3001';

export const options = {
  scenarios: {
    health_check: {
      executor: 'constant-vus',
      vus: 50,
      duration: '60s',
      exec: 'healthCheck',
      tags: { scenario: 'health_check' },
    },
    public_ingest_health: {
      executor: 'constant-vus',
      vus: 50,
      duration: '60s',
      exec: 'publicIngestHealth',
      tags: { scenario: 'public_ingest_health' },
    },
    graph_snapshot: {
      executor: 'constant-vus',
      vus: 50,
      duration: '60s',
      exec: 'graphSnapshot',
      tags: { scenario: 'graph_snapshot' },
    },
  },
  thresholds: {
    'http_req_duration{scenario:health_check}': ['p(95)<200'],
    'http_req_duration{scenario:public_ingest_health}': ['p(95)<200'],
    'http_req_duration{scenario:graph_snapshot}': ['p(95)<200'],
    http_req_failed: ['rate<0.01'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

function runRequest(url, scenarioName) {
  const res = http.get(url);

  check(res, {
    [`${scenarioName}: status is 200`]: (r) => r.status === 200,
    [`${scenarioName}: response time < 500ms`]: (r) => r.timings.duration < 500,
  });

  sleep(1);
}

export function healthCheck() {
  runRequest(`${BASE_URL}/health`, 'health_check');
}

export function publicIngestHealth() {
  runRequest(`${BASE_URL}/api/v1/public/ingest/health`, 'public_ingest_health');
}

export function graphSnapshot() {
  runRequest(`${BASE_URL}/api/v1/public/graph?userId=local`, 'graph_snapshot');
}

// Required by k6 when exec is used — default export can be empty or omitted.
// Kept here as a no-op so `k6 run` without --scenario also works safely.
export default function () {}

export function handleSummary(data) {
  const dur = data.metrics.http_req_duration;
  const p95 = dur?.values['p(95)'] ?? null;
  const p99 = dur?.values['p(99)'] ?? null;
  const avg = dur?.values['avg'] ?? null;
  const failRate = data.metrics.http_req_failed?.values?.rate ?? null;

  console.log('=== Load Test Summary ===');
  console.log(`Total requests: ${data.metrics.http_reqs?.values?.count ?? 0}`);
  console.log(`Failed requests rate: ${failRate !== null ? (failRate * 100).toFixed(2) + '%' : 'N/A'}`);
  console.log(`p95 latency: ${p95 !== null ? p95.toFixed(2) + 'ms' : 'N/A'}`);
  console.log(`p99 latency: ${p99 !== null ? p99.toFixed(2) + 'ms' : 'N/A'}`);
  console.log(`Avg latency: ${avg !== null ? avg.toFixed(2) + 'ms' : 'N/A'}`);

  const passed = p95 !== null && p95 < 200 && failRate !== null && failRate < 0.01;
  const failed = p95 === null || failRate === null;

  if (failed) {
    console.log('WARN: No requests completed — could not evaluate thresholds');
  } else if (passed) {
    console.log('PASS: All thresholds met (p95 < 200ms, error rate < 1%)');
  } else {
    console.log('FAIL: One or more thresholds exceeded');
    if (p95 !== null && p95 >= 200) {
      console.log(`  p95 latency ${p95.toFixed(2)}ms >= 200ms threshold`);
    }
    if (failRate !== null && failRate >= 0.01) {
      console.log(`  Error rate ${(failRate * 100).toFixed(2)}% >= 1% threshold`);
    }
  }

  return {
    'k6/summary.html': htmlReport(data),
  };
}
