// Data plane for the SPA. Knows about three sources, in priority order:
//   1. The hosted online API (apiBaseUrl from web/config.js, or — when
//      apiBaseUrl is blank — the same origin as the page). On the Cloudflare
//      deploy this is the Worker in src/worker.js, which exposes the public
//      ingest + snapshot pair backed by Workers KV so paste-in actions
//      persist across visits.
//   2. The local dev server (scripts/serve.mjs) — exposes /api/ingest/* that
//      shells out to the v1 ingester scripts. Used as a fallback when the
//      online API is unreachable or not configured for this user id.
//   3. The static `data/graph.json` file — used in either case as a fallback
//      and to seed first paint.

const API_GRAPH_PATH = '/api/v1/public/graph';
const API_HEALTH_PATH = '/api/v1/public/ingest/health';
const API_INGEST_TEXT_PATH = '/api/v1/public/ingest/text';
const API_INGEST_MARKDOWN_PATH = '/api/v1/public/ingest/markdown';
const API_INGEST_GRAPH_PATH = '/api/v1/public/ingest/graph';

const ENDPOINT_LOCAL_INGEST = '/api/ingest';

let _localIngestSupported = null;
let _publicApiAvailable = null;

function publicApiUrl(path) {
  const base = (window.GRAPH_CONFIG?.apiBaseUrl || '').trim() || window.location.origin;
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

export async function loadStaticGraph() {
  const res = await fetch(`./data/graph.json?ts=${Date.now()}`, { cache: 'no-store' });
  if (res.status === 404) return { schemaVersion: 1, metadata: {}, nodes: [], edges: [] };
  if (!res.ok) throw new Error(`Failed to load graph (${res.status})`);
  return res.json();
}

/** Run a v1 (filesystem-based) ingester via the local dev server.
 *  Accepts an optional `params` object:
 *    params.env  — { KEY: value } object of env var overrides forwarded to the script.
 *    params.file — { name, content (base64 string), field } for uploading a file.
 */
export async function runLocalIngest(name, params = {}) {
  const body = {};
  if (params.env && Object.keys(params.env).length) body.env = params.env;
  if (params.file) body.file = params.file;

  const res = await fetch(`${ENDPOINT_LOCAL_INGEST}/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let bodyOut = {};
  try { bodyOut = await res.json(); } catch {}
  return { ok: res.ok, status: res.status, ...bodyOut };
}

/** Run a local ingester with environment variable overrides. */
export async function runIngestWithParams(name, env = {}) {
  return runLocalIngest(name, { env });
}

/** Run a local ingester with a file upload (File object from an <input type="file">). */
export async function uploadFileIngest(name, file, envField, extraEnv = {}) {
  const content = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // reader.result is a data URL like "data:...;base64,<data>"
      const b64 = reader.result.split(',')[1];
      resolve(b64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  return runLocalIngest(name, {
    env: extraEnv,
    file: { name: file.name, content, field: envField },
  });
}

/** Check whether GitHub is connected (token held by the local dev server). */
export async function githubOAuthStatus() {
  try {
    const res = await fetch('/api/oauth/github/status');
    if (!res.ok) return { connected: false };
    return res.json();
  } catch {
    return { connected: false };
  }
}

/** Disconnect GitHub OAuth token from the local dev server. */
export async function githubOAuthDisconnect() {
  try {
    await fetch('/api/oauth/github/status', { method: 'DELETE' });
  } catch { /* ignore */ }
}

/** Max polling attempts before giving up on the OAuth popup (1 attempt/second). */
const OAUTH_POLL_MAX_ATTEMPTS = 180;

/** Open a popup to start the GitHub OAuth flow and return a Promise that
 *  resolves to true when the token appears on the server (polling). */
export function startGitHubOAuth() {
  return new Promise((resolve) => {
    const popup = window.open(
      '/api/oauth/github/start',
      'github-oauth',
      'width=700,height=600,scrollbars=yes',
    );

    let attempts = 0;
    const interval = setInterval(async () => {
      attempts += 1;
      try {
        const status = await githubOAuthStatus();
        if (status.connected) {
          clearInterval(interval);
          try { popup?.close(); } catch { /* ignore */ }
          resolve(true);
          return;
        }
      } catch { /* ignore */ }
      // Closed popup before completing, or timeout
      if (popup?.closed || attempts > OAUTH_POLL_MAX_ATTEMPTS) {
        clearInterval(interval);
        resolve(false);
      }
    }, 1000);
  });
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
export async function runIngest(name, params) {
  return runLocalIngest(name, params);
}

// ── Per-connector auto-ingest scheduler ───────────────────────────────────────

/** Maps connectorId → setInterval handle for auto-ingest timers. */
const _autoIngestTimers = new Map();

/**
 * Register (or replace) a periodic auto-ingest callback for a connector.
 * Pass intervalMs = 0 or omit runFn to only clear any existing timer.
 */
export function scheduleAutoIngest(connectorId, intervalMs, runFn) {
  clearAutoIngest(connectorId);
  if (!intervalMs || typeof runFn !== 'function') return;
  const tid = setInterval(runFn, intervalMs);
  _autoIngestTimers.set(connectorId, tid);
}

/** Cancel the auto-ingest timer for a specific connector. */
export function clearAutoIngest(connectorId) {
  const tid = _autoIngestTimers.get(connectorId);
  if (tid != null) { clearInterval(tid); _autoIngestTimers.delete(connectorId); }
}

/** Cancel every active auto-ingest timer. */
export function clearAllAutoIngest() {
  for (const id of [..._autoIngestTimers.keys()]) clearAutoIngest(id);
}

/**
 * Send a pre-parsed graph (nodes + edges) to the public API for ingestion.
 * Used by the client-side ingest path when the local dev server is unavailable.
 */
export async function ingestPublicGraph({ nodes, edges, sourceId }) {
  const url = publicApiUrl(API_INGEST_GRAPH_PATH);
  if (!url) return { ok: false, status: 0, error: 'no apiBaseUrl configured' };

  let body = {};
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: brainUserId(), nodes, edges, sourceId }),
    });
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
  try { body = await res.json(); } catch {}
  return { ok: res.ok, status: res.status, ...body };
}
