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
const API_GRAPH_DELTA_PATH = '/api/v1/public/graph/delta';
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

/**
 * Run a local ingester with multiple files (e.g. a folder picked via
 * webkitdirectory). The dev server materialises them into a tmp directory
 * preserving each file's `webkitRelativePath`, then sets `envField` to the
 * tmp dir path so Node-side ingesters can scan it like a real vault.
 */
export async function uploadFilesIngest(name, files, envField, extraEnv = {}) {
  const list = Array.from(files || []);
  if (list.length === 0) return { ok: false, status: 0, error: 'no files selected' };

  const fileBatch = await Promise.all(list.map((f) => fileToBase64Entry(f, envField)));
  return runLocalIngest(name, {
    env: extraEnv,
    files: fileBatch,
  });
}

function fileToBase64Entry(file, envField) {
  return new Promise((resolveP, rejectP) => {
    const reader = new FileReader();
    reader.onload = () => {
      const b64 = String(reader.result || '').split(',')[1] || '';
      resolveP({
        name: file.name,
        content: b64,
        field: envField,
        relativePath: file.webkitRelativePath || file.name,
      });
    };
    reader.onerror = rejectP;
    reader.readAsDataURL(file);
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

/**
 * Send a (potentially large) batch of nodes/edges to the public API, chunked
 * to stay under the per-request 5 000-node / 20 000-edge cap enforced by the
 * Worker (see SNAPSHOT_MAX_NODES / SNAPSHOT_MAX_EDGES in src/worker.js).
 *
 * Edges are routed to the chunk whose nodes contain *both* endpoints when
 * possible; orphan edges (whose endpoints are split across chunks or refer
 * to nodes already persisted from a prior call) are appended to the final
 * chunk, which is fine because the server merges by id.
 */
export async function ingestPublicBatch({ nodes, edges, sourceId, onChunk }) {
  const allNodes = Array.isArray(nodes) ? nodes : [];
  const allEdges = Array.isArray(edges) ? edges : [];
  if (allNodes.length === 0) {
    return { ok: false, status: 0, error: 'no nodes to ingest' };
  }

  const NODE_CHUNK = 1_500;
  const EDGE_CHUNK = 6_000;

  // Build node chunks.
  const nodeChunks = [];
  for (let i = 0; i < allNodes.length; i += NODE_CHUNK) {
    nodeChunks.push(allNodes.slice(i, i + NODE_CHUNK));
  }

  // For each node chunk, collect edges whose endpoints are both in this chunk.
  // Edges that don't fit (because endpoints are in different chunks) are
  // accumulated and appended to the last chunk in additional follow-up
  // requests sliced at EDGE_CHUNK.
  const accumulatedTrailingEdges = [];
  const sentEdgeIds = new Set();
  let totals = { nodes: 0, edges: 0, totalNodes: 0, totalEdges: 0 };
  let lastBody = {};
  let lastStatus = 0;
  let okAll = true;

  for (let i = 0; i < nodeChunks.length; i++) {
    const chunkNodes = nodeChunks[i];
    const chunkIds = new Set(chunkNodes.map((n) => n.id));
    const chunkEdges = [];
    for (const e of allEdges) {
      if (sentEdgeIds.has(e.id)) continue;
      if (chunkIds.has(e.source) && chunkIds.has(e.target)) {
        if (chunkEdges.length < EDGE_CHUNK) {
          chunkEdges.push(e);
          sentEdgeIds.add(e.id);
        } else {
          accumulatedTrailingEdges.push(e);
        }
      }
    }
    const res = await ingestPublicGraph({
      nodes: chunkNodes,
      edges: chunkEdges,
      sourceId,
    });
    onChunk?.({ index: i, total: nodeChunks.length, ok: res.ok, body: res });
    if (!res.ok) {
      return res;
    }
    totals.nodes += res.nodes ?? chunkNodes.length;
    totals.edges += res.edges ?? chunkEdges.length;
    totals.totalNodes = res.totalNodes ?? totals.totalNodes;
    totals.totalEdges = res.totalEdges ?? totals.totalEdges;
    lastBody = res;
    lastStatus = res.status;
  }

  // Cross-chunk edges (endpoints in different chunks) plus any overflow we
  // bumped to `accumulatedTrailingEdges` because a single chunk hit EDGE_CHUNK.
  const remaining = allEdges
    .filter((e) => !sentEdgeIds.has(e.id))
    .concat(accumulatedTrailingEdges);

  for (let i = 0; i < remaining.length; i += EDGE_CHUNK) {
    const slice = remaining.slice(i, i + EDGE_CHUNK);
    if (slice.length === 0) break;
    // Send as a graph payload re-stating the endpoints we already persisted.
    // The server's sanitizer drops nodes with no id, so we resend the minimal
    // anchor set: the unique ids referenced by this edge slice.
    const referenced = new Set();
    for (const e of slice) { referenced.add(e.source); referenced.add(e.target); }
    const anchorNodes = allNodes.filter((n) => referenced.has(n.id));
    const res = await ingestPublicGraph({
      nodes: anchorNodes,
      edges: slice,
      sourceId,
    });
    onChunk?.({ index: nodeChunks.length + Math.floor(i / EDGE_CHUNK), total: -1, ok: res.ok, body: res });
    if (!res.ok) {
      okAll = false;
      lastBody = res;
      lastStatus = res.status;
      break;
    }
    totals.edges += res.edges ?? slice.length;
    totals.totalNodes = res.totalNodes ?? totals.totalNodes;
    totals.totalEdges = res.totalEdges ?? totals.totalEdges;
    lastBody = res;
    lastStatus = res.status;
  }

  return { ok: okAll, status: lastStatus, ...lastBody, ...totals };
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
  if (tid != null) {
    clearInterval(tid);
    _autoIngestTimers.delete(connectorId);
  }
}

/** Cancel every active auto-ingest timer. */
export function clearAllAutoIngest() {
  for (const id of [..._autoIngestTimers.keys()]) clearAutoIngest(id);
}

// ── Connector catalog API ─────────────────────────────────────────────────────

const API_CONNECTORS_PATH = '/api/v1/connectors';
const API_OAUTH_CONNECT_PATH = '/api/v1/oauth/connect';
const GRAPH_INGEST_LIMITS = {
  maxNodes: 5_000,
  maxEdges: 20_000,
  maxIdChars: 240,
  maxLabelChars: 200,
  maxTypeChars: 64,
  maxRelationChars: 64,
  maxSourceIdChars: 64,
  maxSourceUrlChars: 2_048,
  maxMetadataKeys: 40,
  maxArrayItems: 40,
  maxStringChars: 1_000,
  maxDepth: 3,
};

function clampGraphString(value, max) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function clampGraphMetadata(value, depth = 0) {
  if (value == null) return undefined;
  if (typeof value === 'string') return value.slice(0, GRAPH_INGEST_LIMITS.maxStringChars);
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean') return value;
  if (depth >= GRAPH_INGEST_LIMITS.maxDepth) return undefined;
  if (Array.isArray(value)) {
    return value
      .slice(0, GRAPH_INGEST_LIMITS.maxArrayItems)
      .map((item) => clampGraphMetadata(item, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (typeof value === 'object') {
    const out = {};
    let count = 0;
    for (const [key, entry] of Object.entries(value)) {
      if (count >= GRAPH_INGEST_LIMITS.maxMetadataKeys) break;
      const safeKey = clampGraphString(key, GRAPH_INGEST_LIMITS.maxTypeChars);
      const safeVal = clampGraphMetadata(entry, depth + 1);
      if (safeKey && safeVal !== undefined) {
        out[safeKey] = safeVal;
        count += 1;
      }
    }
    return Object.keys(out).length ? out : undefined;
  }
  return undefined;
}

function sanitizeGraphNode(node, fallbackSourceId) {
  if (!node || typeof node !== 'object') return null;
  const id = clampGraphString(node.id, GRAPH_INGEST_LIMITS.maxIdChars);
  if (!id) return null;
  const label = clampGraphString(node.label, GRAPH_INGEST_LIMITS.maxLabelChars) || id;
  const type = clampGraphString(node.type, GRAPH_INGEST_LIMITS.maxTypeChars) || 'note';
  const sourceId = clampGraphString(node.sourceId, GRAPH_INGEST_LIMITS.maxSourceIdChars)
    || fallbackSourceId
    || 'client';
  const sourceUrl = clampGraphString(node.sourceUrl, GRAPH_INGEST_LIMITS.maxSourceUrlChars);
  const createdAt = clampGraphString(node.createdAt, 64);
  const updatedAt = clampGraphString(node.updatedAt, 64);
  const metadata = clampGraphMetadata(node.metadata);
  return {
    id,
    label,
    type,
    sourceId,
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function sanitizeGraphEdge(edge) {
  if (!edge || typeof edge !== 'object') return null;
  const source = clampGraphString(edge.source, GRAPH_INGEST_LIMITS.maxIdChars);
  const target = clampGraphString(edge.target, GRAPH_INGEST_LIMITS.maxIdChars);
  const relation = clampGraphString(edge.relation, GRAPH_INGEST_LIMITS.maxRelationChars) || 'RELATED_TO';
  if (!source || !target || source === target) return null;
  const id = clampGraphString(edge.id, GRAPH_INGEST_LIMITS.maxIdChars) || `${source}|${relation}|${target}`;
  const createdAt = clampGraphString(edge.createdAt, 64);
  const metadata = clampGraphMetadata(edge.metadata);
  return {
    id,
    source,
    target,
    relation,
    ...(Number.isFinite(edge.weight) ? { weight: Math.max(0, Math.min(1, edge.weight)) } : {}),
    ...(typeof edge.inferred === 'boolean' ? { inferred: edge.inferred } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function sanitizeGraphPayload({ nodes, edges, sourceId }) {
  const safeSourceId = clampGraphString(sourceId, GRAPH_INGEST_LIMITS.maxSourceIdChars) || 'client';
  const safeNodes = (Array.isArray(nodes) ? nodes : [])
    .map((node) => sanitizeGraphNode(node, safeSourceId))
    .filter(Boolean)
    .slice(0, GRAPH_INGEST_LIMITS.maxNodes);
  const safeEdges = (Array.isArray(edges) ? edges : [])
    .map((edge) => sanitizeGraphEdge(edge))
    .filter(Boolean)
    .slice(0, GRAPH_INGEST_LIMITS.maxEdges);
  return { sourceId: safeSourceId, nodes: safeNodes, edges: safeEdges };
}

/** Fetch configured connector statuses for the current user. Returns [] on error. */
export async function loadConnectorStatuses() {
  const url = publicApiUrl(
    `${API_CONNECTORS_PATH}?userId=${encodeURIComponent(brainUserId())}`,
  );
  if (!url) return [];
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    return (await res.json()) || [];
  } catch {
    return [];
  }
}

/** Configure an API-key connector: stores the encrypted key and enqueues an immediate sync. */
export async function configureConnectorApiKey(connectorId, apiKey, metadata) {
  const url = publicApiUrl(
    `${API_CONNECTORS_PATH}/${encodeURIComponent(connectorId)}/configure?userId=${encodeURIComponent(brainUserId())}`,
  );
  if (!url) return { ok: false, error: 'no apiBaseUrl configured' };
  try {
    const body = { apiKey, ...(metadata ? { metadata } : {}) };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, ...json };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Trigger an immediate sync for a configured connector. */
export async function triggerConnectorSync(connectorId) {
  const url = publicApiUrl(
    `${API_CONNECTORS_PATH}/${encodeURIComponent(connectorId)}/sync?userId=${encodeURIComponent(brainUserId())}`,
  );
  if (!url) return { ok: false, error: 'no apiBaseUrl configured' };
  try {
    const res = await fetch(url, { method: 'POST' });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, ...json };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Start an OAuth flow for a catalog connector.
 * Returns `{ ok: true, authorizeUrl }` on success so the caller can open a popup.
 */
export async function connectOAuthConnector(connectorId) {
  const url = publicApiUrl(
    `${API_OAUTH_CONNECT_PATH}/${encodeURIComponent(connectorId)}?userId=${encodeURIComponent(brainUserId())}`,
  );
  if (!url) return { ok: false, error: 'no apiBaseUrl configured' };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ returnTo: window.location.href }),
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, ...json };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Send a pre-parsed graph (nodes + edges) to the public API for ingestion.
 * Used by the client-side ingest path when the local dev server is unavailable.
 */
export async function ingestPublicGraph({ nodes, edges, sourceId }) {
  const url = publicApiUrl(API_INGEST_GRAPH_PATH);
  if (!url) return { ok: false, status: 0, error: 'no apiBaseUrl configured' };
  const payload = sanitizeGraphPayload({ nodes, edges, sourceId });
  if (payload.nodes.length === 0) {
    return { ok: false, status: 0, error: 'no valid nodes to ingest' };
  }

  let body = {};
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: brainUserId(), ...payload }),
    });
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
  try { body = await res.json(); } catch {}
  return { ok: res.ok, status: res.status, ...body };
}
