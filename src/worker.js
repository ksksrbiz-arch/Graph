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
import { handleCortexApi } from './worker/cortex/router.js';
import { handleMcpServer } from './worker/mcp-server.js';
import { handleFinanceApi } from './worker/finance/router.js';
import { handleOAuthApi } from './worker/oauth.js';
import { dispatchCron } from './worker/cortex/scheduler.js';
import { recordEvent, upsertNodesAndEdges } from './worker/d1-store.js';
import { upsertNodes as upsertVectors } from './worker/cortex/vector.js';

const TEXT_MAX_LENGTH = 200_000;
const TITLE_MAX_LENGTH = 200;
const SNAPSHOT_MAX_NODES = 5_000;
const SNAPSHOT_MAX_EDGES = 20_000;
const GRAPH_ID_MAX_LENGTH = 240;
const GRAPH_LABEL_MAX_LENGTH = 200;
const GRAPH_TYPE_MAX_LENGTH = 64;
const GRAPH_METADATA_MAX_KEYS = 40;
const GRAPH_METADATA_MAX_ITEMS = 40;
const GRAPH_METADATA_MAX_DEPTH = 3;
const GRAPH_METADATA_STRING_MAX_LENGTH = 1_000;

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

export default {
  // Cron-driven autonomy entry point. Cloudflare invokes this on every
  // configured trigger in wrangler.jsonc → triggers.crons. We fan out to
  // dispatchCron() which knows the cron→prompt mapping.
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(dispatchCron(env, controller.cron));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight — the public endpoints are intentionally same-origin in
    // production, but the frontend may be opened from `localhost:3000` (dev
    // server) and call into a deployed Worker. Mirror the origin so dev
    // tooling works without further configuration.
    if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    // MCP server endpoint — must intercept BEFORE /api/ filter so /mcp
    // (the conventional MCP path used by Claude Desktop, Cursor, etc.)
    // is served by handleMcpServer instead of falling through to assets.
    {
      const mcp = await handleMcpServer(request, env, url);
      if (mcp) {
        for (const [k, v] of Object.entries(corsHeaders(request))) mcp.headers.set(k, v);
        return mcp;
      }
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
  const cortex = await handleCortexApi(request, env, url);
  if (cortex) return cortex;

  const finance = await handleFinanceApi(request, env, url);
  if (finance) return finance;

  const oauth = await handleOAuthApi(request, env, url);
  if (oauth) return oauth;

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

  const nodes = dto.nodes
    .map((node) => sanitizeGraphNode(node, sourceId))
    .filter(Boolean)
    .slice(0, SNAPSHOT_MAX_NODES);
  const edges = Array.isArray(dto.edges)
    ? dto.edges
        .map((edge) => sanitizeGraphEdge(edge))
        .filter(Boolean)
        .slice(0, SNAPSHOT_MAX_EDGES)
    : [];
  if (nodes.length === 0) {
    return jsonResponse({ error: 'no valid nodes to ingest' }, 400);
  }

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

function trimGraphString(value, max) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function sanitizeGraphMetadata(value, depth = 0) {
  if (value == null) return undefined;
  if (typeof value === 'string') return value.slice(0, GRAPH_METADATA_STRING_MAX_LENGTH);
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean') return value;
  if (depth >= GRAPH_METADATA_MAX_DEPTH) return undefined;
  if (Array.isArray(value)) {
    return value
      .slice(0, GRAPH_METADATA_MAX_ITEMS)
      .map((item) => sanitizeGraphMetadata(item, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (typeof value === 'object') {
    const out = {};
    let count = 0;
    for (const [key, entry] of Object.entries(value)) {
      if (count >= GRAPH_METADATA_MAX_KEYS) break;
      const safeKey = trimGraphString(key, GRAPH_TYPE_MAX_LENGTH);
      const safeValue = sanitizeGraphMetadata(entry, depth + 1);
      if (safeKey && safeValue !== undefined) {
        out[safeKey] = safeValue;
        count += 1;
      }
    }
    return Object.keys(out).length ? out : undefined;
  }
  return undefined;
}

function sanitizeGraphNode(node, fallbackSourceId) {
  if (!node || typeof node !== 'object') return null;
  const id = trimGraphString(node.id, GRAPH_ID_MAX_LENGTH);
  if (!id) return null;
  const label = trimGraphString(node.label, GRAPH_LABEL_MAX_LENGTH) || id;
  const type = trimGraphString(node.type, GRAPH_TYPE_MAX_LENGTH) || 'note';
  const sourceId = trimGraphString(node.sourceId, GRAPH_TYPE_MAX_LENGTH)
    || trimGraphString(fallbackSourceId, GRAPH_TYPE_MAX_LENGTH)
    || 'client';
  const sourceUrl = trimGraphString(node.sourceUrl, 2048);
  const createdAt = trimGraphString(node.createdAt, 64);
  const updatedAt = trimGraphString(node.updatedAt, 64);
  const metadata = sanitizeGraphMetadata(node.metadata);
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
  const source = trimGraphString(edge.source, GRAPH_ID_MAX_LENGTH);
  const target = trimGraphString(edge.target, GRAPH_ID_MAX_LENGTH);
  const relation = trimGraphString(edge.relation, GRAPH_TYPE_MAX_LENGTH) || 'RELATED_TO';
  if (!source || !target || source === target) return null;
  const id = trimGraphString(edge.id, GRAPH_ID_MAX_LENGTH) || `${source}|${relation}|${target}`;
  const createdAt = trimGraphString(edge.createdAt, 64);
  const metadata = sanitizeGraphMetadata(edge.metadata);
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
      // Fire-and-forget vector embed. Catches its own errors so a flaky
      // AI call doesn't roll back the KV/D1 ingest above.
      upsertVectors(env, userId, parsed.nodes ?? []).catch((e) => {
        console.warn('[mirror] vector upsert failed:', e.message);
        return 0;
      }),
    ]);
    return evt;
  } catch (err) {
    console.warn('[d1-mirror] failed:', err.message);
    return null;
  }
}
