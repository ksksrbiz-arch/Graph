/**
 * MCP server for the personal knowledge graph.
 *
 * Exposes Graph's `data/graph.json` (the same snapshot the SPA renders and
 * the Worker mirrors) over the [Model Context Protocol](https://modelcontextprotocol.io)
 * so that Claude Desktop, Cursor, Codex CLI, and other MCP clients can query
 * the user's PKG without any extra plumbing.
 *
 * Transport: stdio (newline-delimited JSON-RPC 2.0). Each message is a single
 * line of UTF-8 JSON terminated by `\n`, which is what the official MCP SDK
 * uses for its stdio transport. We implement the protocol directly here so we
 * stay zero-dependency in line with the rest of `scripts/`.
 *
 * Tools (callable via `tools/call`):
 *   - `search_nodes`  — substring match against node label, type, and metadata.
 *   - `get_node`      — fetch a node by id, optionally with one-hop neighbors.
 *   - `subgraph`      — BFS expansion of a seed node up to `depth` hops.
 *   - `list_sources`  — list ingested sources and the run stats they recorded.
 *   - `stats`         — totals and breakdown by node type / edge relation.
 *
 * Resources (readable via `resources/read`):
 *   - `graph://snapshot` — the full graph as JSON.
 *   - `graph://sources`  — the sources list as JSON.
 *
 * Configuration (env vars):
 *   GRAPH_PATH  — path to the graph snapshot. Defaults to `<repo>/data/graph.json`.
 *
 * Wiring it into Claude Desktop (~/.config/Claude/claude_desktop_config.json):
 *
 *   {
 *     "mcpServers": {
 *       "graph-pkg": {
 *         "command": "node",
 *         "args": ["/absolute/path/to/Graph/scripts/mcp-server.mjs"]
 *       }
 *     }
 *   }
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const GRAPH_PATH = process.env.GRAPH_PATH || resolve(REPO_ROOT, 'data', 'graph.json');

/** MCP protocol versions we know how to speak. We echo the client's version
 *  back if it's in this set; otherwise we fall back to the most recent. */
const SUPPORTED_PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18'];
const FALLBACK_PROTOCOL_VERSION = '2024-11-05';

const SERVER_INFO = { name: 'graph-pkg', version: '0.1.0' };

// ── Graph loading ─────────────────────────────────────────────────────────────

let cachedGraph = null;
let cachedAt = 0;
const CACHE_TTL_MS = 2_000; // re-read if a newer ingest just landed

async function loadGraph() {
  const now = Date.now();
  if (cachedGraph && now - cachedAt < CACHE_TTL_MS) return cachedGraph;
  try {
    const txt = await readFile(GRAPH_PATH, 'utf8');
    const parsed = JSON.parse(txt);
    cachedGraph = {
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
      edges: Array.isArray(parsed.edges) ? parsed.edges : [],
      metadata: parsed.metadata || {},
    };
  } catch (err) {
    if (err.code === 'ENOENT') {
      cachedGraph = { nodes: [], edges: [], metadata: { sources: [] } };
    } else {
      throw err;
    }
  }
  cachedAt = now;
  return cachedGraph;
}

// ── Tool implementations ──────────────────────────────────────────────────────

function nodeBlurb(node) {
  return {
    id: node.id,
    label: node.label,
    type: node.type,
    sourceId: node.sourceId,
    sourceUrl: node.sourceUrl,
  };
}

/** Lower-cases and concatenates the searchable text for a node. Fields are
 *  joined by U+0001 (SOH) — a control character that cannot appear in real
 *  user queries — so substring matches can never silently span two fields
 *  (e.g. matching the tail of `label` plus the head of `type`). */
function searchableText(node) {
  const FIELD_SEP = ' \u0001 ';
  const parts = [
    node.label,
    node.type,
    node.sourceId,
    node.sourceUrl,
    node.metadata && typeof node.metadata === 'object'
      ? JSON.stringify(node.metadata)
      : '',
  ];
  return parts.filter(Boolean).join(FIELD_SEP).toLowerCase();
}

async function toolSearchNodes(args = {}) {
  const query = String(args.query ?? '').trim().toLowerCase();
  const type = args.type ? String(args.type) : null;
  const limit = clampInt(args.limit, 1, 200, 25);
  if (!query && !type) {
    throw rpcError(-32602, 'search_nodes requires either `query` or `type`');
  }
  const { nodes } = await loadGraph();

  const matches = [];
  for (const n of nodes) {
    if (type && n.type !== type) continue;
    if (query && !searchableText(n).includes(query)) continue;
    matches.push(n);
    if (matches.length >= limit) break;
  }

  return {
    total: matches.length,
    truncated: matches.length === limit,
    nodes: matches.map((n) => ({
      ...nodeBlurb(n),
      metadata: n.metadata,
    })),
  };
}

async function toolGetNode(args = {}) {
  const id = String(args.id ?? '').trim();
  if (!id) throw rpcError(-32602, 'get_node requires `id`');
  const includeNeighbors = args.neighbors !== false; // default true

  const { nodes, edges } = await loadGraph();
  const node = nodes.find((n) => n.id === id);
  if (!node) {
    return { found: false, id };
  }

  if (!includeNeighbors) {
    return { found: true, node };
  }

  const incident = edges.filter((e) => e.source === id || e.target === id);
  const neighborIds = new Set();
  for (const e of incident) {
    neighborIds.add(e.source === id ? e.target : e.source);
  }
  const neighborIndex = new Map(
    nodes.filter((n) => neighborIds.has(n.id)).map((n) => [n.id, n]),
  );

  return {
    found: true,
    node,
    edges: incident.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      relation: e.relation,
      weight: e.weight,
    })),
    neighbors: [...neighborIndex.values()].map(nodeBlurb),
  };
}

async function toolSubgraph(args = {}) {
  const seed = String(args.seed ?? '').trim();
  if (!seed) throw rpcError(-32602, 'subgraph requires `seed` (a node id)');
  const depth = clampInt(args.depth, 1, 4, 2);
  const limit = clampInt(args.limit, 1, 500, 100);

  const { nodes, edges } = await loadGraph();
  const nodeIndex = new Map(nodes.map((n) => [n.id, n]));
  if (!nodeIndex.has(seed)) {
    return { found: false, seed };
  }

  // Build adjacency once, undirected.
  const adj = new Map();
  for (const e of edges) {
    if (!adj.has(e.source)) adj.set(e.source, []);
    if (!adj.has(e.target)) adj.set(e.target, []);
    adj.get(e.source).push(e);
    adj.get(e.target).push(e);
  }

  const visited = new Set([seed]);
  const collectedEdges = new Map();
  let frontier = [seed];

  for (let d = 0; d < depth && visited.size < limit; d += 1) {
    const next = [];
    for (const id of frontier) {
      const list = adj.get(id) || [];
      for (const e of list) {
        collectedEdges.set(e.id || `${e.source}|${e.relation}|${e.target}`, e);
        const other = e.source === id ? e.target : e.source;
        if (!visited.has(other) && visited.size < limit) {
          visited.add(other);
          next.push(other);
        }
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }

  return {
    found: true,
    seed,
    depth,
    truncated: visited.size >= limit,
    nodes: [...visited].map((id) => nodeIndex.get(id)).filter(Boolean),
    edges: [...collectedEdges.values()].filter(
      (e) => visited.has(e.source) && visited.has(e.target),
    ),
  };
}

async function toolListSources() {
  const { metadata } = await loadGraph();
  return { sources: Array.isArray(metadata?.sources) ? metadata.sources : [] };
}

async function toolStats() {
  const { nodes, edges, metadata } = await loadGraph();
  const byType = {};
  for (const n of nodes) {
    byType[n.type] = (byType[n.type] || 0) + 1;
  }
  const byRelation = {};
  for (const e of edges) {
    byRelation[e.relation] = (byRelation[e.relation] || 0) + 1;
  }
  return {
    nodes: nodes.length,
    edges: edges.length,
    byType,
    byRelation,
    sources: Array.isArray(metadata?.sources) ? metadata.sources.length : 0,
    updatedAt: metadata?.updatedAt || null,
  };
}

const TOOLS = [
  {
    name: 'search_nodes',
    description:
      'Search the personal knowledge graph for nodes whose label, type, sourceId, ' +
      'sourceUrl, or metadata contains the given query string. Optionally filter by ' +
      'node type. Returns up to `limit` (default 25, max 200) matches.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Substring to match (case-insensitive).' },
        type: { type: 'string', description: 'Restrict to a specific node type, e.g. "repo", "code-function", "person".' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 25 },
      },
    },
    handler: toolSearchNodes,
  },
  {
    name: 'get_node',
    description:
      'Fetch a single node by id. By default returns the node plus its directly ' +
      'connected edges and one-hop neighbors; set `neighbors: false` for just the node.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string' },
        neighbors: { type: 'boolean', default: true },
      },
    },
    handler: toolGetNode,
  },
  {
    name: 'subgraph',
    description:
      'BFS expansion of a seed node out to `depth` hops (default 2, max 4), capped ' +
      'at `limit` nodes (default 100, max 500). Useful for "show me everything ' +
      'connected to X" exploration.',
    inputSchema: {
      type: 'object',
      required: ['seed'],
      properties: {
        seed: { type: 'string', description: 'Seed node id.' },
        depth: { type: 'integer', minimum: 1, maximum: 4, default: 2 },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
      },
    },
    handler: toolSubgraph,
  },
  {
    name: 'list_sources',
    description:
      'List the ingested sources recorded in graph metadata (e.g. github, claude-code, ' +
      'code, markdown) along with the stats each ingester reported on its last run.',
    inputSchema: { type: 'object', properties: {} },
    handler: toolListSources,
  },
  {
    name: 'stats',
    description:
      'Return totals and per-type / per-relation breakdowns for the current snapshot.',
    inputSchema: { type: 'object', properties: {} },
    handler: toolStats,
  },
];

const TOOL_INDEX = new Map(TOOLS.map((t) => [t.name, t]));

// ── Resources ────────────────────────────────────────────────────────────────

const RESOURCES = [
  {
    uri: 'graph://snapshot',
    name: 'graph-snapshot',
    description: 'Full personal knowledge graph snapshot (nodes + edges + metadata).',
    mimeType: 'application/json',
    read: async () => JSON.stringify(await loadGraph()),
  },
  {
    uri: 'graph://sources',
    name: 'graph-sources',
    description: 'Ingested sources and their last-run stats.',
    mimeType: 'application/json',
    read: async () => JSON.stringify((await loadGraph()).metadata?.sources || []),
  },
];

const RESOURCE_INDEX = new Map(RESOURCES.map((r) => [r.uri, r]));

// ── JSON-RPC plumbing ────────────────────────────────────────────────────────

function rpcError(code, message, data) {
  const err = new Error(message);
  err.rpcCode = code;
  if (data !== undefined) err.rpcData = data;
  return err;
}

function clampInt(value, min, max, fallback) {
  const n = Number.isFinite(Number(value)) ? Math.floor(Number(value)) : NaN;
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function send(message) {
  // MCP stdio transport: one JSON object per line, UTF-8, terminated by `\n`.
  process.stdout.write(JSON.stringify(message) + '\n');
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  send({ jsonrpc: '2.0', id, error });
}

function asTextContent(payload) {
  // MCP tool results are an array of content blocks. We return a single
  // `text` block holding pretty-printed JSON; that's how the SDK formats
  // structured tool output and clients (Claude/Cursor) display it cleanly.
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

async function handleRequest(msg) {
  const { method, params, id } = msg;

  // Notifications have no `id` and never get a response.
  const isNotification = id === undefined || id === null;

  try {
    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : FALLBACK_PROTOCOL_VERSION;
        if (!isNotification) {
          sendResult(id, {
            protocolVersion,
            capabilities: { tools: {}, resources: {} },
            serverInfo: SERVER_INFO,
          });
        }
        return;
      }
      case 'notifications/initialized':
      case 'initialized':
        // Client done initializing — nothing for us to do.
        return;
      case 'ping':
        if (!isNotification) sendResult(id, {});
        return;
      case 'tools/list':
        if (!isNotification) {
          sendResult(id, {
            tools: TOOLS.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          });
        }
        return;
      case 'tools/call': {
        const name = params?.name;
        const tool = TOOL_INDEX.get(name);
        if (!tool) throw rpcError(-32601, `Unknown tool: ${name}`);
        const out = await tool.handler(params?.arguments || {});
        if (!isNotification) sendResult(id, asTextContent(out));
        return;
      }
      case 'resources/list':
        if (!isNotification) {
          sendResult(id, {
            resources: RESOURCES.map((r) => ({
              uri: r.uri,
              name: r.name,
              description: r.description,
              mimeType: r.mimeType,
            })),
          });
        }
        return;
      case 'resources/read': {
        const uri = params?.uri;
        const resource = RESOURCE_INDEX.get(uri);
        if (!resource) throw rpcError(-32602, `Unknown resource: ${uri}`);
        const text = await resource.read();
        if (!isNotification) {
          sendResult(id, {
            contents: [{ uri: resource.uri, mimeType: resource.mimeType, text }],
          });
        }
        return;
      }
      default:
        if (!isNotification) {
          throw rpcError(-32601, `Method not found: ${method}`);
        }
        return;
    }
  } catch (err) {
    if (isNotification) {
      // Per JSON-RPC, errors on notifications are silent — log to stderr.
      process.stderr.write(`mcp-server: ${method} notification failed: ${err.message}\n`);
      return;
    }
    const code = err.rpcCode || -32603;
    sendError(id, code, err.message || 'Internal error', err.rpcData);
  }
}

// ── stdio loop ────────────────────────────────────────────────────────────────

function startStdio() {
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch (err) {
      // Parse errors on a per-line basis can't be tied to an id — emit a
      // best-effort JSON-RPC parse error with id=null.
      sendError(null, -32700, `Parse error: ${err.message}`);
      return;
    }
    // Fire-and-forget: handleRequest catches its own errors.
    handleRequest(msg).catch((err) => {
      process.stderr.write(`mcp-server: unexpected handler crash: ${err.stack || err.message}\n`);
    });
  });
  rl.on('close', () => {
    // Client disconnected — exit cleanly.
    process.exit(0);
  });
}

// Allow this module to be imported by tests without auto-starting the loop.
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startStdio();
}

export {
  handleRequest,
  loadGraph,
  toolSearchNodes,
  toolGetNode,
  toolSubgraph,
  toolListSources,
  toolStats,
  TOOLS,
  RESOURCES,
  GRAPH_PATH,
};
