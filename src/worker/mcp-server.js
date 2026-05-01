// MCP server — exposes the cortex tool surface as a remote Streamable-HTTP
// MCP endpoint. Other agents (Claude Desktop, Cursor, IDEs, my own cortex)
// can register `https://graph.skdev-371.workers.dev/mcp` and treat the
// personal knowledge graph as a tool source.
//
// This is the BIDIRECTIONAL counterpart to src/worker/cortex/mcp-registry.js
// (Layer 10 client). Together they make the cortex a node on the open MCP
// web — both consuming external MCPs and emitting its own tools.
//
// Wire protocol:
//   POST /mcp   body: JSON-RPC 2.0 message
//   Methods:
//     - initialize → returns serverInfo + capabilities + sessionId via header
//     - notifications/initialized (notification, returns 202)
//     - tools/list → returns array of {name, description, inputSchema}
//     - tools/call {name, arguments} → returns {content:[{type:'text',text}]}
//
// Auth: optional Bearer token if env.MCP_BEARER is set. Without it the
// endpoint is public (single-tenant single-userId convention).
//
// Tools exposed (curated subset of the cortex registry):
//   recall · graph-query · recent-events · stats · write-note · summarize

import { listEvents, statsByKind, recordEvent, upsertNodesAndEdges } from './d1-store.js';
import { recall as vectorRecall } from './cortex/vector.js';
import { parseText } from './text-parser.js';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'pkg-cortex', version: '1.0.0' };

// What we expose. Schemas mirror the input args of the matching cortex tool.
const TOOLS = [
  {
    name: 'recall',
    description: 'Semantic recall over the personal knowledge graph via vector embeddings. Returns top-k semantically similar nodes.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Free-text query.' },
        topK:  { type: 'number', description: 'How many results (default 6).', default: 6 },
      },
    },
  },
  {
    name: 'graph-query',
    description: 'Substring-search the flat node projection. Use when you need exact label matches; use recall for semantic.',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Label substring filter.' },
        type:  { type: 'string', description: 'Node type filter (note, document, concept, bookmark, ...).' },
        limit: { type: 'number', description: 'Max rows (default 10, max 50).', default: 10 },
      },
    },
  },
  {
    name: 'recent-events',
    description: 'List the last N ingest events for the user. Each row carries source kind, node count, status.',
    inputSchema: {
      type: 'object',
      properties: {
        limit:      { type: 'number', description: 'Default 10, max 50.', default: 10 },
        sourceKind: { type: 'string', description: 'Filter by kind (text, voice, vision, webhook, cortex, ...).' },
        since:      { type: 'number', description: 'Only events with ts >= since (ms epoch).' },
      },
    },
  },
  {
    name: 'stats',
    description: 'Counts of nodes by type, edges by type, events by source kind. Quick health check on the graph.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'write-note',
    description: 'Persist a free-form note into the graph as a document + paragraph nodes.',
    inputSchema: {
      type: 'object',
      required: ['text'],
      properties: {
        title: { type: 'string' },
        text:  { type: 'string' },
      },
    },
  },
];

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

/**
 * Top-level handler. Returns null when the path isn't ours so the caller
 * (src/worker.js) falls through to other routers / static assets.
 */
export async function handleMcpServer(request, env, url) {
  if (url.pathname !== '/mcp' && url.pathname !== '/api/v1/mcp') return null;

  // CORS preflight + token check share the same allowlist
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  if (!checkAuth(request, env)) {
    return jsonResponse({ jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized' } }, 401);
  }

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'POST required' }, 405);
  }

  let msg;
  try { msg = await request.json(); } catch { return jsonResponse({ jsonrpc: '2.0', error: { code: -32700, message: 'parse error' } }, 400); }
  if (msg?.jsonrpc !== '2.0') return jsonResponse({ jsonrpc: '2.0', error: { code: -32600, message: 'invalid request' } }, 400);

  const userId = pickUserId(request, env);

  // Notifications: id absent. Return 202 with no body.
  const isNotification = msg.id === undefined || msg.id === null;
  const sessionId = request.headers.get('mcp-session-id') || crypto.randomUUID();

  let result;
  let error = null;
  try {
    switch (msg.method) {
      case 'initialize':
        result = {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        };
        break;
      case 'notifications/initialized':
      case 'notifications/cancelled':
        // Notifications — no response body, but we still 202.
        return new Response(null, {
          status: 202,
          headers: { ...corsHeaders(request), 'mcp-session-id': sessionId },
        });
      case 'tools/list':
        result = { tools: TOOLS };
        break;
      case 'tools/call':
        result = await callTool(env, userId, msg.params?.name, msg.params?.arguments || {});
        break;
      case 'ping':
        result = {};
        break;
      default:
        error = { code: -32601, message: `method not found: ${msg.method}` };
    }
  } catch (err) {
    error = { code: -32000, message: err.message };
  }

  if (isNotification) {
    return new Response(null, { status: 202, headers: { ...corsHeaders(request), 'mcp-session-id': sessionId } });
  }
  const body = error
    ? { jsonrpc: '2.0', id: msg.id, error }
    : { jsonrpc: '2.0', id: msg.id, result };
  return jsonResponse(body, 200, { 'mcp-session-id': sessionId });
}

// ── tool implementations ─────────────────────────────────────────────

async function callTool(env, userId, name, args) {
  if (!name) return wrapError('tool name required');
  switch (name) {
    case 'recall': {
      const out = await vectorRecall(env, userId, (args?.query || '').toString(), { topK: args?.topK });
      if (!out.ok) return wrapError(out.error || 'recall failed');
      return wrapText(JSON.stringify({ matches: out.matches }, null, 2));
    }
    case 'graph-query': {
      if (!env.GRAPH_DB) return wrapError('GRAPH_DB binding missing');
      const limit = clampInt(args?.limit, 1, 50, 10);
      const where = ['user_id = ?']; const params = [userId];
      if (args?.label) { where.push('label LIKE ?'); params.push(`%${String(args.label).slice(0,80)}%`); }
      if (args?.type)  { where.push('type = ?');    params.push(String(args.type).slice(0,40)); }
      const sql = `SELECT id, type, label, source_kind, last_seen_at FROM nodes WHERE ${where.join(' AND ')} ORDER BY last_seen_at DESC LIMIT ${limit}`;
      const { results } = await env.GRAPH_DB.prepare(sql).bind(...params).all();
      return wrapText(JSON.stringify({ nodes: results || [] }, null, 2));
    }
    case 'recent-events': {
      const events = await listEvents(env.GRAPH_DB, {
        userId,
        limit: clampInt(args?.limit, 1, 50, 10),
        sourceKind: args?.sourceKind ? String(args.sourceKind) : undefined,
        since: args?.since ? Number(args.since) : undefined,
      });
      return wrapText(JSON.stringify({ events }, null, 2));
    }
    case 'stats': {
      const out = await statsByKind(env.GRAPH_DB, { userId });
      return wrapText(JSON.stringify(out, null, 2));
    }
    case 'write-note': {
      const text = (args?.text || '').toString();
      if (!text.trim()) return wrapError('text is required');
      const title = (args?.title || `MCP-written note — ${new Date().toISOString().slice(0,19)}`).toString().slice(0,200);
      const parsed = await parseText(text, { userId, sourceId: 'mcp-server', title });
      const merge = env.__mergeAndPersist;
      if (typeof merge !== 'function' || !env.GRAPH_KV) return wrapError('KV merge not wired');
      const snap = await merge(env.GRAPH_KV, userId, parsed, 'mcp-server');
      if (env.GRAPH_DB) {
        await Promise.all([
          recordEvent(env.GRAPH_DB, {
            userId, sourceKind: 'mcp-server', kind: 'write-note',
            payload: { title, length: text.length },
            nodeCount: parsed.nodes.length, edgeCount: parsed.edges.length,
            status: 'applied',
          }),
          upsertNodesAndEdges(env.GRAPH_DB, {
            userId, sourceKind: 'mcp-server',
            nodes: parsed.nodes, edges: parsed.edges,
          }),
        ]);
      }
      return wrapText(JSON.stringify({
        parentId: parsed.parentId,
        addedNodes: parsed.nodes.length,
        totalNodes: snap.nodes.length,
        totalEdges: snap.edges.length,
      }, null, 2));
    }
    default:
      return wrapError(`unknown tool: ${name}`);
  }
}

// ── helpers ──────────────────────────────────────────────────────────

function wrapText(text)  { return { content: [{ type: 'text', text }] }; }
function wrapError(text) { return { content: [{ type: 'text', text }], isError: true }; }

function checkAuth(request, env) {
  const required = (env.MCP_BEARER || '').toString().trim();
  if (!required) return true; // public when unset
  const got = request.headers.get('authorization') || '';
  return got === `Bearer ${required}`;
}
function pickUserId(request, env) {
  const explicit = request.headers.get('x-cortex-user');
  if (explicit) return String(explicit).trim();
  const csv = (env.PUBLIC_INGEST_USER_IDS || 'local').toString();
  return (csv.split(',')[0] || 'local').trim();
}
function clampInt(v, lo, hi, dflt) {
  const n = Number.isFinite(+v) ? Math.floor(+v) : dflt;
  return Math.max(lo, Math.min(hi, n));
}
function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extraHeaders } });
}
function corsHeaders(request) {
  const origin = request.headers.get('origin');
  if (!origin) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type, mcp-session-id, authorization, x-cortex-user',
    'access-control-expose-headers': 'mcp-session-id',
    'access-control-max-age': '86400',
    'vary': 'Origin',
  };
}
