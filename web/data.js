// Data plane for the SPA. Knows about three sources, in priority order:
//   1. The hosted API (apiBaseUrl from web/config.js) — exposes a public
//      ingest + snapshot pair so the Cloudflare deploy can mutate the graph
//      live without a filesystem dev server.
//   2. The local dev server (scripts/serve.mjs) — exposes /api/ingest/* that
//      shells out to the v1 ingester scripts.
//   3. The static `data/graph.json` file — used in either case as a fallback
//      and to seed first paint.

const API_GRAPH_PATH = '/api/v1/public/graph';
const API_GRAPH_DELTA_PATH = '/api/v1/public/graph/delta';
const API_HEALTH_PATH = '/api/v1/public/ingest/health';
const API_INGEST_TEXT_PATH = '/api/v1/public/ingest/text';
const API_INGEST_MARKDOWN_PATH = '/api/v1/public/ingest/markdown';

const ENDPOINT_LOCAL_INGEST = '/api/ingest';

let _localIngestSupported = null;
let _publicApiAvailable = null;

function publicApiUrl(path) {
  const base = (window.GRAPH_CONFIG?.apiBaseUrl || '').trim();
  if (!base) return null;
  try {
    return new URL(path, base).toString();
  } catch {
    return null;
  }
}

function brainUserId() {
  return window.GRAPH_CONFIG?.brainUserId || 'local';
}

/** True when the deployed API exposes the public ingest namespace and the
 *  configured demo userId is on its allowlist. Cached so we only probe once
 *  per page load. */
export async function publicIngestAvailable() {
  if (_publicApiAvailable !== null) return _publicApiAvailable;
  const url = publicApiUrl(API_HEALTH_PATH);
  if (!url) {
    _publicApiAvailable = false;
    return false;
  }
  try {
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) {
      _publicApiAvailable = false;
      return false;
    }
    const body = await res.json();
    _publicApiAvailable = body.ok === true && body.enabled === true;
  } catch {
    _publicApiAvailable = false;
  }
  return _publicApiAvailable;
}

/** True when the local dev server (scripts/serve.mjs) is fronting us. */
export async function localIngestSupported() {
  if (_localIngestSupported !== null) return _localIngestSupported;
  try {
    const res = await fetch(`${ENDPOINT_LOCAL_INGEST}/health`, { method: 'GET' });
    _localIngestSupported = res.ok;
  } catch {
    _localIngestSupported = false;
  }
  return _localIngestSupported;
}

/** Back-compat: callers asking "can we ingest at all?". */
export async function ingestSupported() {
  const [a, b] = await Promise.all([localIngestSupported(), publicIngestAvailable()]);
  return a || b;
}

/** Loads the graph in priority order:
 *   1. Public API snapshot if available + non-empty
 *   2. Static data/graph.json
 *  The first non-empty source wins. Static fallback always runs because the
 *  API may be cold-starting on Fly. */
export async function loadGraph() {
  const fromApi = await loadGraphFromApi();
  if (fromApi && (fromApi.nodes?.length ?? 0) > 0) return fromApi;
  return loadStaticGraph();
}

export async function loadGraphFromApi() {
  if (!(await publicIngestAvailable())) return null;
  const url = publicApiUrl(`${API_GRAPH_PATH}?userId=${encodeURIComponent(brainUserId())}`);
  if (!url) return null;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    const body = await res.json();
    if (!body || !Array.isArray(body.nodes)) return null;
    return {
      schemaVersion: body.schemaVersion || 1,
      metadata: body.metadata || {},
      nodes: body.nodes,
      edges: body.edges || [],
    };
  } catch {
    return null;
  }
}

/** Fetch nodes + edges added since `since` (ISO-8601 string or epoch ms).
 *  Returns null when the API isn't available; the caller can treat that the
 *  same as "no new nodes" and try again on the next poll. */
export async function loadGraphDelta(since) {
  if (!(await publicIngestAvailable())) return null;
  const sinceParam = typeof since === 'number' ? String(since) : (since || '');
  const url = publicApiUrl(
    `${API_GRAPH_DELTA_PATH}?userId=${encodeURIComponent(brainUserId())}&since=${encodeURIComponent(sinceParam)}`,
  );
  if (!url) return null;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    const body = await res.json();
    if (!body || !Array.isArray(body.nodes)) return null;
    return {
      schemaVersion: body.schemaVersion || 1,
      metadata: body.metadata || {},
      nodes: body.nodes,
      edges: body.edges || [],
    };
  } catch {
    return null;
  }
}

export async function loadStaticGraph() {
  const res = await fetch(`./data/graph.json?ts=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to load graph (${res.status})`);
  return res.json();
}

/** Run a v1 (filesystem-based) ingester via the local dev server. */
export async function runLocalIngest(name) {
  const res = await fetch(`${ENDPOINT_LOCAL_INGEST}/${encodeURIComponent(name)}`, { method: 'POST' });
  let body = {};
  try { body = await res.json(); } catch {}
  return { ok: res.ok, status: res.status, ...body };
}

/** Send a free-text or markdown blob to the public API for ingestion. */
export async function ingestPublicText({ text, title, format = 'text' }) {
  const path = format === 'markdown' ? API_INGEST_MARKDOWN_PATH : API_INGEST_TEXT_PATH;
  const url = publicApiUrl(path);
  if (!url) return { ok: false, status: 0, error: 'no apiBaseUrl configured' };

  const payload = format === 'markdown'
    ? { userId: brainUserId(), markdown: text, title }
    : { userId: brainUserId(), text, title };

  let body = {};
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
  try { body = await res.json(); } catch {}
  return { ok: res.ok, status: res.status, ...body };
}

/** Back-compat shim used by the "Ingest Claude Code" button. */
export async function runIngest(name) {
  return runLocalIngest(name);
}
