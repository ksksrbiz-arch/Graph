/**
 * Pieces MCP ingester (v1).
 *
 * Connects to a locally running [Pieces OS](https://pieces.app) MCP server
 * over its Streamable-HTTP transport, calls a retrieval tool (default
 * `ask_pieces_ltm`), and merges the returned memories/snippets into
 * `data/graph.json` so your Pieces long-term memory shows up alongside
 * notes, bookmarks, code, etc.
 *
 * Why an MCP client (and not a Pieces SDK)? Pieces OS already exposes a
 * stable [Model Context Protocol](https://modelcontextprotocol.io) endpoint
 * — same contract every other MCP-enabled tool uses — so we just speak
 * JSON-RPC to it. The actual transport code is the same `openSession` /
 * `callTool` helpers the v2 cortex Worker uses (`src/worker/cortex/mcp-client.js`),
 * so behaviour stays identical between v1 ingestion and v2 dispatch.
 *
 * The default URL is the one Pieces OS advertises locally:
 *
 *   http://localhost:39300/model_context_protocol/2025-03-26/mcp
 *
 * Each run produces:
 *  - One `pieces` source node ("Pieces OS") that every memory hangs off via
 *    `PART_OF` (weight 0.5).
 *  - One `pieces-query` node per prompt sent (label = the prompt).
 *  - One `pieces-memory` node per text content block returned. Label is
 *    derived from the first non-empty line; the full text is in
 *    `metadata.text`. If the server returns `structuredContent` with an
 *    array of items (`{title, snippet, url, ...}`), each item becomes its
 *    own node instead, with proper `sourceUrl`.
 *  - `pieces-query --ANSWERED_BY--> pieces-memory` edges (weight 0.6).
 *
 * Configuration (env vars):
 *   PIECES_MCP_URL       — base MCP endpoint. Default
 *                          http://localhost:39300/model_context_protocol/2025-03-26/mcp
 *   PIECES_AUTH_TOKEN    — optional bearer token. Local Pieces OS doesn't
 *                          require one; remote/hosted setups might.
 *   PIECES_QUERY_TOOL    — tool name to call. Default: ask_pieces_ltm.
 *                          Use PIECES_LIST_TOOLS=1 to discover tools.
 *   PIECES_QUERY_ARG     — name of the string argument the tool takes.
 *                          Default: question.
 *   PIECES_QUERY         — single prompt to send.
 *   PIECES_QUERIES       — semicolon-separated list of prompts. Overrides
 *                          PIECES_QUERY when set.
 *   PIECES_LIST_TOOLS    — set to "1"/"true" to only list available tools
 *                          (no graph mutation, useful for smoke tests).
 *   PIECES_MAX_NODES     — safety cap on memory nodes per query. Default 200.
 *
 * Usage:
 *   # First, verify the connection and see what tools are exposed:
 *   PIECES_LIST_TOOLS=1 node scripts/ingest-pieces-mcp.mjs
 *
 *   # Default ingest (asks Pieces LTM a generic recap question):
 *   node scripts/ingest-pieces-mcp.mjs
 *
 *   # Multiple targeted prompts:
 *   PIECES_QUERIES="What did I save about graph databases?;Show recent code snippets" \
 *     node scripts/ingest-pieces-mcp.mjs
 */

import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GraphBuilder, loadGraph, saveGraph, stableId } from './lib/graph-store.mjs';
import { openSession } from '../src/worker/cortex/mcp-client.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const GRAPH_PATH = join(REPO_ROOT, 'data', 'graph.json');

const SOURCE_ID = 'pieces';

const PIECES_MCP_URL = (
  process.env.PIECES_MCP_URL ||
  'http://localhost:39300/model_context_protocol/2025-03-26/mcp'
).trim();
const PIECES_AUTH_TOKEN = (process.env.PIECES_AUTH_TOKEN || '').trim() || undefined;
// When PIECES_QUERY_TOOL is unset we auto-pick from this list in order. Pieces
// OS builds vary in which retrieval tools they expose — newer versions bundle
// the LTM ask tool, older ones only ship the workstream/conversation searchers.
// Picking automatically means a fresh install works without env tweaking.
const TOOL_PREFERENCE = [
  'ask_pieces_ltm',
  'conversations_full_text_search',
  'workstream_summaries_full_text_search',
  'workstream_events_full_text_search',
  'materials_vector_search',
];

// Pieces' search tools take `query`; ask_pieces_ltm takes `question`. Map per
// tool when the caller hasn't pinned PIECES_QUERY_ARG.
const TOOL_DEFAULT_ARG = {
  ask_pieces_ltm: 'question',
  conversations_full_text_search: 'query',
  workstream_summaries_full_text_search: 'query',
  workstream_events_full_text_search: 'query',
  materials_vector_search: 'query',
};

const PIECES_QUERY_TOOL = (process.env.PIECES_QUERY_TOOL || '').trim();
const PIECES_QUERY_ARG = (process.env.PIECES_QUERY_ARG || '').trim();
const DEFAULT_QUERY =
  'Summarize the most relevant memories, snippets, and references from my Pieces long-term memory.';
const PIECES_LIST_TOOLS = /^(1|true|yes)$/i.test(process.env.PIECES_LIST_TOOLS || '');
const MAX_NODES = Math.max(1, Number(process.env.PIECES_MAX_NODES || 200));

function parseQueries() {
  const multi = (process.env.PIECES_QUERIES || '').trim();
  if (multi) {
    return multi
      .split(';')
      .map((q) => q.trim())
      .filter(Boolean);
  }
  const single = (process.env.PIECES_QUERY || '').trim();
  return [single || DEFAULT_QUERY];
}

async function main() {
  console.log(`Pieces MCP ingester → ${PIECES_MCP_URL}`);

  let session;
  try {
    session = await openSession(PIECES_MCP_URL, { authToken: PIECES_AUTH_TOKEN });
  } catch (err) {
    console.error(
      `Could not reach Pieces MCP at ${PIECES_MCP_URL}: ${err.message}\n` +
        'Make sure Pieces OS is running and exposes the MCP endpoint, ' +
        'or set PIECES_MCP_URL to a reachable URL.',
    );
    process.exit(1);
  }
  if (!session.ok) {
    console.error(
      `MCP initialize failed: ${session.error}\n` +
        'Check that the URL is correct and Pieces OS MCP is enabled.',
    );
    process.exit(1);
  }
  if (session.serverInfo) {
    const { name, version } = session.serverInfo;
    console.log(
      `Connected to ${name || 'pieces-mcp'}${version ? ` v${version}` : ''} ` +
        `(protocol ${session.protocolVersion || 'unknown'})`,
    );
  }

  const lt = await session.listTools();
  if (!lt.ok) {
    console.error(`tools/list failed: ${lt.error}`);
    process.exit(1);
  }
  const tools = lt.tools || [];
  console.log(`Server exposes ${tools.length} tool(s): ${tools.map((t) => t.name).join(', ') || '(none)'}`);

  if (PIECES_LIST_TOOLS) {
    for (const t of tools) {
      console.log(`\n  • ${t.name}`);
      if (t.description) console.log(`      ${t.description.split('\n')[0].slice(0, 200)}`);
    }
    return;
  }

  const tool = pickTool(tools);
  if (!tool) {
    const wanted = PIECES_QUERY_TOOL || TOOL_PREFERENCE.join(', ');
    console.error(
      `No usable retrieval tool found on server (looked for: ${wanted}).\n` +
        `Available: ${tools.map((t) => t.name).join(', ') || '(none)'}\n` +
        'Set PIECES_QUERY_TOOL to one of the names above, run with ' +
        'PIECES_LIST_TOOLS=1 to inspect them, or fall back to the REST ' +
        'ingester (`node scripts/ingest-pieces-rest.mjs`) which talks ' +
        "directly to Pieces OS's HTTP API.",
    );
    process.exit(1);
  }

  // Resolve the query-arg name: explicit env wins, else per-tool default,
  // else the legacy `question` for backward-compat.
  const queryArg = PIECES_QUERY_ARG || TOOL_DEFAULT_ARG[tool.name] || 'question';

  const queries = parseQueries();
  console.log(
    `Calling \`${tool.name}\` (arg: ${queryArg}) with ${queries.length} prompt(s).`,
  );

  const existing = await loadGraph(GRAPH_PATH);
  const builder = new GraphBuilder(existing);

  // Anchor source node — every memory hangs off this so the graph view
  // can highlight the Pieces sub-tree.
  const sourceNodeId = stableId(SOURCE_ID, 'source:pieces-os');
  builder.upsertNode({
    id: sourceNodeId,
    label: 'Pieces OS',
    type: 'source',
    sourceId: SOURCE_ID,
    sourceUrl: PIECES_MCP_URL,
    metadata: {
      transport: 'mcp/streamable-http',
      protocolVersion: session.protocolVersion,
      serverInfo: session.serverInfo,
      tool: tool.name,
    },
  });

  let totalMemories = 0;
  const perQuery = [];

  for (const prompt of queries) {
    const args = { [queryArg]: prompt };
    let res;
    try {
      res = await session.callTool(tool.name, args);
    } catch (err) {
      console.error(`  prompt "${truncate(prompt, 60)}" — ${err.message}`);
      continue;
    }
    if (!res.ok) {
      console.error(`  prompt "${truncate(prompt, 60)}" — ${res.error}`);
      continue;
    }

    const queryId = stableId(SOURCE_ID, `query:${prompt}`);
    builder.upsertNode({
      id: queryId,
      label: truncate(prompt, 80),
      type: 'pieces-query',
      sourceId: SOURCE_ID,
      metadata: { prompt, tool: tool.name, queryArg },
    });

    const memories = extractMemories(res);
    let kept = 0;
    for (const mem of memories) {
      if (kept >= MAX_NODES) break;
      const memKey = mem.id || mem.url || mem.text || mem.title || `${prompt}:${kept}`;
      const memId = stableId(SOURCE_ID, `memory:${memKey}`);
      builder.upsertNode({
        id: memId,
        label: mem.label || truncate(mem.title || mem.text || 'memory', 80),
        type: 'pieces-memory',
        sourceId: SOURCE_ID,
        sourceUrl: mem.url,
        metadata: {
          title: mem.title,
          text: mem.text,
          snippet: mem.snippet,
          contentType: mem.contentType,
          assetId: mem.id,
          tags: mem.tags,
          extra: mem.extra,
        },
      });
      builder.upsertEdge({
        source: queryId,
        target: memId,
        relation: 'ANSWERED_BY',
        weight: 0.6,
      });
      builder.upsertEdge({
        source: memId,
        target: sourceNodeId,
        relation: 'PART_OF',
        weight: 0.5,
      });
      kept += 1;
    }

    perQuery.push({ prompt, memories: kept });
    totalMemories += kept;
    console.log(
      `  • "${truncate(prompt, 60)}" → ${kept} memory node(s)` +
        (memories.length > kept ? ` (capped from ${memories.length})` : ''),
    );

    builder.upsertEdge({
      source: queryId,
      target: sourceNodeId,
      relation: 'PART_OF',
      weight: 0.4,
    });
  }

  if (totalMemories === 0) {
    console.warn(
      'No memory nodes were ingested. The tool may have returned an empty answer ' +
        'or a content type the parser does not understand. Run with PIECES_LIST_TOOLS=1 ' +
        'to inspect available tools, or try a different PIECES_QUERY.',
    );
  }

  builder.recordSource(SOURCE_ID, {
    endpoint: PIECES_MCP_URL,
    tool: tool.name,
    queries: perQuery,
    memories: totalMemories,
    protocolVersion: session.protocolVersion,
  });

  await saveGraph(GRAPH_PATH, builder.graph);

  console.log(
    `\nIngested ${totalMemories} memory node(s) from ${perQuery.length} prompt(s).`,
  );
  console.log(
    `Graph: ${builder.graph.nodes.length} nodes · ${builder.graph.edges.length} edges`,
  );
  console.log(`Wrote ${GRAPH_PATH}`);
}

/**
 * Pull a list of memory-shaped objects out of an MCP `tools/call` reply.
 *
 * MCP servers return one of (often a mix of) these in `result.content`:
 *  - `{type: 'text', text: '...'}`
 *  - `{type: 'resource', resource: {uri, text, mimeType}}`
 *  - `{type: 'image', ...}` (we ignore these for the graph)
 *
 * Some servers also populate `result.structuredContent` with an
 * application-specific JSON object. Pieces in particular tends to put
 * arrays of memories under keys like `memories`, `assets`, `results`,
 * or `items`. We try those keys, fall back to scanning any array of
 * objects in the structured payload, and finally fall back to splitting
 * the flattened text into bullet-style chunks.
 */
function extractMemories(res) {
  const out = [];

  // 1) Structured content — preferred when present.
  const struct = res.structured;
  if (struct && typeof struct === 'object') {
    const arr = pickFirstArray(struct, ['memories', 'assets', 'results', 'items', 'answers', 'snippets']);
    if (arr) {
      for (const item of arr) {
        const mem = normalizeStructuredItem(item);
        if (mem) out.push(mem);
      }
      if (out.length) return out;
    }
  }

  // 2) Resource content blocks (rich, addressable).
  for (const block of res.content || []) {
    if (block?.type === 'resource' && block.resource) {
      const r = block.resource;
      out.push({
        id: r.uri,
        url: r.uri,
        title: r.name || r.uri,
        text: typeof r.text === 'string' ? r.text : undefined,
        snippet: typeof r.text === 'string' ? truncate(r.text, 240) : undefined,
        contentType: r.mimeType,
      });
    }
  }
  if (out.length) return out;

  // 3) Plain text — split on a blank line / horizontal rule. If only one
  //    block comes back, keep it as a single memory rather than over-eagerly
  //    splitting prose.
  const text = (res.text || '').trim();
  if (!text) return out;
  // Split on a blank line / horizontal rule. `filter(Boolean)` after split
  // guarantees at least one chunk when `text` is non-empty (the unsplit
  // text itself), so we can iterate `chunks` directly.
  const chunks = text
    .split(/\n\s*(?:---+|\*\*\*+|===+|\n)\s*\n/)
    .map((c) => c.trim())
    .filter(Boolean);
  for (const chunk of chunks) {
    const firstLine = chunk.split('\n').find((l) => l.trim()) || chunk;
    out.push({
      title: truncate(firstLine.replace(/^[#>\-*\s]+/, ''), 80),
      text: chunk,
      snippet: truncate(chunk, 240),
    });
  }
  return out;
}

function normalizeStructuredItem(item) {
  if (!item || typeof item !== 'object') return null;
  // Common Pieces / general MCP fields, in priority order.
  const id = item.id || item.assetId || item.asset_id || item.uri || item.uuid;
  const url = item.url || item.link || item.uri || item.sourceUrl;
  const title = item.title || item.name || item.label;
  const text =
    typeof item.text === 'string'
      ? item.text
      : typeof item.content === 'string'
      ? item.content
      : typeof item.body === 'string'
      ? item.body
      : typeof item.snippet === 'string'
      ? item.snippet
      : undefined;
  const snippet =
    typeof item.snippet === 'string'
      ? item.snippet
      : text
      ? truncate(text, 240)
      : undefined;
  const tags = Array.isArray(item.tags) ? item.tags : undefined;
  const contentType = item.mimeType || item.contentType || item.type;
  if (!id && !url && !title && !text) return null;
  return {
    id: id ? String(id) : undefined,
    url: url ? String(url) : undefined,
    title: title ? String(title) : undefined,
    text,
    snippet,
    tags,
    contentType: contentType ? String(contentType) : undefined,
    extra: stripKnown(item),
  };
}

function pickFirstArray(obj, keys) {
  for (const k of keys) {
    if (Array.isArray(obj[k])) return obj[k];
  }
  // Fallback: first array-of-objects value.
  for (const v of Object.values(obj)) {
    if (Array.isArray(v) && v.length && typeof v[0] === 'object') return v;
  }
  return null;
}

const KNOWN_KEYS = new Set([
  'id', 'assetId', 'asset_id', 'uri', 'uuid',
  'url', 'link', 'sourceUrl',
  'title', 'name', 'label',
  'text', 'content', 'body', 'snippet',
  'tags', 'mimeType', 'contentType', 'type',
]);

function stripKnown(item) {
  const out = {};
  for (const [k, v] of Object.entries(item)) {
    if (KNOWN_KEYS.has(k)) continue;
    // Skip large arrays to keep the graph file lean.
    if (Array.isArray(v) && v.length > 32) continue;
    out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

function truncate(s, n) {
  if (typeof s !== 'string') return s;
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + '…';
}

/**
 * Resolve which retrieval tool to call. Honors PIECES_QUERY_TOOL when set;
 * otherwise picks the first match from TOOL_PREFERENCE that the server
 * actually exposes. Returns the tool object (with name + schema) or null.
 */
function pickTool(tools) {
  if (PIECES_QUERY_TOOL) {
    return tools.find((t) => t.name === PIECES_QUERY_TOOL) || null;
  }
  for (const candidate of TOOL_PREFERENCE) {
    const match = tools.find((t) => t.name === candidate);
    if (match) return match;
  }
  return null;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
