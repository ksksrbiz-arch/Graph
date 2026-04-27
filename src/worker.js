// Cloudflare Worker entrypoint for the Graph SPA.
//
// Two responsibilities:
//
// 1. Serve the static frontend from the `web/` directory via the ASSETS
//    binding configured in wrangler.jsonc.
//
// 2. Implement the same `/api/v1/public/*` surface that apps/api (NestJS)
//    exposes, so the website hosted at https://graph.skdev-371.workers.dev/
//    has a same-origin online API and the brain / graph nodes survive across
//    page reloads, devices, and browsers. Persistence is backed by Workers KV
//    (binding name: GRAPH_KV) — when no KV binding is configured we still
//    serve the assets but the public ingest endpoints respond with
//    `enabled: false` so the SPA falls back to its read-only static graph.
//
// Implements:
//   GET  /api/v1/public/ingest/health
//   POST /api/v1/public/ingest/text
//   POST /api/v1/public/ingest/markdown
//   GET  /api/v1/public/graph?userId=<id>
//
// Anything else is handed to the assets binding so the SPA keeps its
// HTML/JS/CSS/data file routes.

import { parseMarkdown, parseText } from './worker/text-parser.js';
import { handleIngressApi } from './worker/ingress.js';
import { recordEvent, upsertNodesAndEdges } from './worker/d1-store.js';

const TEXT_MAX_LENGTH = 200_000;
const TITLE_MAX_LENGTH = 200;
const SNAPSHOT_MAX_NODES = 5_000;
const SNAPSHOT_MAX_EDGES = 20_000;

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight — the public endpoints are intentionally same-origin in
    // production, but the frontend may be opened from `localhost:3000` (dev
    // server) and call into a deployed Worker. Mirror the origin so dev
    // tooling works without further configuration.
    if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    if (url.pathname.startsWith('/api/')) {
      const res = await handleApi(request, env, url);
      if (res) {
        for (const [k, v] of Object.entries(corsHeaders(request))) res.headers.set(k, v);
        return res;
      }
    }

    // Fall through to static assets.
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return jsonResponse({ error: 'assets binding missing' }, 500);
  },
};

async function handleApi(request, env, url) {
  // Expose the merge fn so the ingress module can persist into KV without
  // importing this file (would be circular). Read-only inside ingress.js.
  if (!env.__mergeAndPersist) env.__mergeAndPersist = mergeAndPersist;

  // New routes (batch / url / webhook / events / sources / stats) handled
  // first; falls through to the existing health/text/markdown/graph router
  // when null.
  const ingress = await handleIngressApi(request, env, url);
  if (ingress) return ingress;

  const { pathname } = url;
  const allowed = allowedUserIds(env);
  const enabled = Boolean(env.GRAPH_KV) && allowed.size > 0;

  if (pathname === '/api/v1/public/ingest/health' && request.method === 'GET') {
    return jsonResponse({
      ok: true,
      enabled,
      formats: ['text', 'markdown'],
    });
  }

  if (pathname === '/api/v1/public/graph' && request.method === 'GET') {
    const userId = (url.searchParams.get('userId') || '').trim();
    if (!userId) return jsonResponse({ error: 'userId query param is required' }, 400);
    if (!allowed.has(userId)) {
      return jsonResponse({ error: `userId=${userId} is not on the public allowlist` }, 403);
    }
    if (!env.GRAPH_KV) return jsonResponse({ error: 'persistence not configured' }, 503);
    const snapshot = await readSnapshot(env.GRAPH_KV, userId);
    return jsonResponse(snapshot);
  }

  if (pathname === '/api/v1/public/ingest/text' && request.method === 'POST') {
    return ingest(request, env, allowed, 'text');
  }

  if (pathname === '/api/v1/public/ingest/markdown' && request.method === 'POST') {
    return ingest(request, env, allowed, 'markdown');
  }

  if (pathname === '/api/v1/public/ingest/graph' && request.method === 'POST') {
    return ingestGraph(request, env, allowed);
  }

  // Not an API endpoint we own — let the caller fall through.
  return null;
}

async function ingest(request, env, allowed, format) {
  if (!env.GRAPH_KV) {
    return jsonResponse({ error: 'persistence not configured' }, 503);
  }

  let dto;
  try {
    dto = await request.json();
  } catch {
    return jsonResponse({ error: 'invalid JSON body' }, 400);
  }

  const userId = typeof dto?.userId === 'string' ? dto.userId.trim() : '';
  if (!userId) return jsonResponse({ error: 'userId is required' }, 400);
  if (!allowed.has(userId)) {
    return jsonResponse({ error: `userId=${userId} is not on the public ingest allowlist` }, 403);
  }

  const contentField = format === 'markdown' ? 'markdown' : 'text';
  const content = typeof dto?.[contentField] === 'string' ? dto[contentField] : '';
  if (!content.trim()) return jsonResponse({ error: `${contentField} is required` }, 400);
  if (content.length > TEXT_MAX_LENGTH) {
    return jsonResponse({ error: `${contentField} exceeds ${TEXT_MAX_LENGTH} characters` }, 413);
  }

  const title = (typeof dto?.title === 'string' && dto.title.trim().length > 0
    ? dto.title.trim()
    : defaultTitle(format)
  ).slice(0, TITLE_MAX_LENGTH);

  const sourceId = format === 'markdown' ? 'obsidian' : 'bookmarks';
  const parsed = format === 'markdown'
    ? await parseMarkdown(content, { userId, sourceId, title })
    : await parseText(content, { userId, sourceId, title });

  const snapshot = await mergeAndPersist(env.GRAPH_KV, userId, parsed, sourceId);
  const evt = await mirrorToD1(env, { userId, sourceId, sourceKind: format, kind: format, parsed, payload: { format, title, length: content.length } });

  return jsonResponse({
    userId,
    format,
    eventId: evt?.id ?? null,
    deduped: evt?.deduped ?? false,
    parentId: parsed.parentId,
    nodes: parsed.nodes.length,
    edges: parsed.edges.length,
    totalNodes: snapshot.nodes.length,
    totalEdges: snapshot.edges.length,
    brainQueuedReload: false,
  });
}

async function ingestGraph(request, env, allowed) {
  if (!env.GRAPH_KV) {
    return jsonResponse({ error: 'persistence not configured' }, 503);
  }

  let dto;
  try {
    dto = await request.json();
  } catch {
    return jsonResponse({ error: 'invalid JSON body' }, 400);
  }

  const userId = typeof dto?.userId === 'string' ? dto.userId.trim() : '';
  if (!userId) return jsonResponse({ error: 'userId is required' }, 400);
  if (!allowed.has(userId)) {
    return jsonResponse({ error: `userId=${userId} is not on the public ingest allowlist` }, 403);
  }

  if (!Array.isArray(dto.nodes)) {
    return jsonResponse({ error: 'nodes array is required' }, 400);
  }

  const sourceId = typeof dto.sourceId === 'string' && dto.sourceId.trim()
    ? dto.sourceId.trim()
    : 'client';

  // Basic shape validation — each item must at least have an id string.
  const nodes = dto.nodes
    .filter((n) => n && typeof n.id === 'string' && n.id)
    .slice(0, SNAPSHOT_MAX_NODES);
  const edges = Array.isArray(dto.edges)
    ? dto.edges
        .filter((e) => e && typeof e.id === 'string' && e.source && e.target)
        .slice(0, SNAPSHOT_MAX_EDGES)
    : [];

  const snapshot = await mergeAndPersist(env.GRAPH_KV, userId, { nodes, edges }, sourceId);
  const evt = await mirrorToD1(env, { userId, sourceId, sourceKind: 'graph', kind: 'graph', parsed: { nodes, edges }, payload: { sourceId, nodes: nodes.length, edges: edges.length } });

  return jsonResponse({
    ok: true,
    userId,
    sourceId,
    eventId: evt?.id ?? null,
    deduped: evt?.deduped ?? false,
    nodes: nodes.length,
    edges: edges.length,
    totalNodes: snapshot.nodes.length,
    totalEdges: snapshot.edges.length,
  });
}

// ── persistence ───────────────────────────────────────────────────────

const SNAPSHOT_KEY = (userId) => `graph:${userId}`;

async function readSnapshot(kv, userId) {
  const raw = await kv.get(SNAPSHOT_KEY(userId), 'json');
  if (!raw || !Array.isArray(raw.nodes)) return emptySnapshot(userId);
  return {
    schemaVersion: raw.schemaVersion || 1,
    metadata: raw.metadata || { updatedAt: new Date().toISOString(), userId, sources: [] },
    nodes: raw.nodes,
    edges: Array.isArray(raw.edges) ? raw.edges : [],
  };
}

function emptySnapshot(userId) {
  return {
    schemaVersion: 1,
    metadata: { updatedAt: new Date().toISOString(), userId, sources: [] },
    nodes: [],
    edges: [],
  };
}

async function mergeAndPersist(kv, userId, parsed, sourceId) {
  const current = await readSnapshot(kv, userId);

  const nodeIndex = new Map(current.nodes.map((n) => [n.id, n]));
  for (const node of parsed.nodes) {
    const existing = nodeIndex.get(node.id);
    if (existing) {
      existing.label = node.label ?? existing.label;
      existing.metadata = { ...(existing.metadata || {}), ...(node.metadata || {}) };
      existing.updatedAt = node.updatedAt;
      if (node.sourceUrl) existing.sourceUrl = node.sourceUrl;
    } else {
      nodeIndex.set(node.id, { ...node });
    }
  }

  const edgeIndex = new Map(current.edges.map((e) => [e.id, e]));
  for (const edge of parsed.edges) {
    const existing = edgeIndex.get(edge.id);
    if (existing) {
      existing.weight = clampUnit((existing.weight + edge.weight) / 2);
      existing.metadata = {
        ...(existing.metadata || {}),
        ...(edge.metadata || {}),
        count: ((existing.metadata && existing.metadata.count) || 1) + 1,
      };
    } else {
      edgeIndex.set(edge.id, { ...edge, metadata: { count: 1, ...(edge.metadata || {}) } });
    }
  }

  // Cap snapshot size so a single run-away ingest can't blow past KV's 25 MiB
  // value cap. Drop the oldest items first.
  let nodes = [...nodeIndex.values()];
  let edges = [...edgeIndex.values()];
  if (nodes.length > SNAPSHOT_MAX_NODES) {
    nodes.sort((a, b) => (a.updatedAt || '').localeCompare(b.updatedAt || ''));
    nodes = nodes.slice(-SNAPSHOT_MAX_NODES);
    const keep = new Set(nodes.map((n) => n.id));
    edges = edges.filter((e) => keep.has(e.source) && keep.has(e.target));
  }
  if (edges.length > SNAPSHOT_MAX_EDGES) {
    edges = edges.slice(-SNAPSHOT_MAX_EDGES);
  }

  const sources = new Set((current.metadata?.sources || []).map((s) => (typeof s === 'string' ? s : s?.name)).filter(Boolean));
  if (sourceId) sources.add(sourceId);

  const snapshot = {
    schemaVersion: 1,
    metadata: {
      updatedAt: new Date().toISOString(),
      userId,
      sources: [...sources],
    },
    nodes,
    edges,
  };

  await kv.put(SNAPSHOT_KEY(userId), JSON.stringify(snapshot));
  return snapshot;
}

// ── helpers ───────────────────────────────────────────────────────────

function allowedUserIds(env) {
  const csv = (env.PUBLIC_INGEST_USER_IDS || 'local').toString();
  return new Set(
    csv
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function defaultTitle(format) {
  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
  return format === 'markdown'
    ? `Pasted markdown — ${stamp}`
    : `Pasted text — ${stamp}`;
}

function clampUnit(x) {
  if (Number.isNaN(x)) return 0.4;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS } });
}

function corsHeaders(request) {
  const origin = request.headers.get('origin');
  // Only attach CORS headers when there is an actual cross-origin request to
  // honour. Same-origin browser requests don't need them, and returning a
  // wildcard for header-less callers (e.g. server-to-server) just adds noise.
  if (!origin) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}


// ── d1 mirror ────────────────────────────────────────────────────────
//
// Best-effort: write to the D1 event log + flat projection alongside KV.
// Returns the event row (or null on error). KV is the source of truth for
// rendering; D1 is the source of truth for SQL queries.
async function mirrorToD1(env, { userId, sourceId, sourceKind, kind, parsed, payload }) {
  if (!env.GRAPH_DB) return null;
  try {
    const [evt] = await Promise.all([
      recordEvent(env.GRAPH_DB, {
        userId, sourceId, sourceKind, kind,
        payload,
        nodeCount: parsed.nodes?.length ?? 0,
        edgeCount: parsed.edges?.length ?? 0,
        status: 'applied',
      }),
      upsertNodesAndEdges(env.GRAPH_DB, {
        userId, sourceKind,
        nodes: parsed.nodes,
        edges: parsed.edges,
      }),
    ]);
    return evt;
  } catch (err) {
    console.warn('[d1-mirror] failed:', err.message);
    return null;
  }
}
