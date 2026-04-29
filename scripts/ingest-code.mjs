/**
 * Code-graph ingester (v1).
 *
 * Pulls a code-intelligence graph (files, folders, functions, classes, methods,
 * plus IMPORTS / CALLS / EXTENDS / IMPLEMENTS / DEFINES / CONTAINS edges) from a
 * locally running [GitNexus](https://github.com/abhigyanpatwari/GitNexus)
 * server and merges it into Graph's `data/graph.json` so code structure shows
 * up alongside notes, bookmarks, GitHub repos, etc.
 *
 * Why a server (and not a CLI shell-out)? `gitnexus serve` exposes a stable
 * HTTP contract and can already host many indexed repos at once — we just call
 * it. Run it yourself first, e.g.:
 *
 *   npx gitnexus@latest analyze /path/to/your/repo
 *   npx gitnexus@latest serve            # starts http://localhost:4747
 *
 * Then run this ingester.
 *
 * Each indexed repo produces:
 *  - A `repo` node (name, indexedAt, stats).
 *  - One node per file/folder/function/class/method/etc., typed `code-<label>`
 *    (e.g. `code-file`, `code-function`). Symbol nodes link to their file via
 *    `DEFINED_IN`; the file links to the repo via `PART_OF`.
 *  - Edges mirroring gitnexus relationships (`CALLS`, `IMPORTS`, `EXTENDS`,
 *    `IMPLEMENTS`, `DEFINES`, `CONTAINS`, …). Edge weight uses the gitnexus
 *    `confidence` field when available, defaulting to 0.5.
 *
 * Configuration (env vars):
 *   GITNEXUS_URL              — base URL of `gitnexus serve`. Default
 *                               http://localhost:4747.
 *   GITNEXUS_REPO             — repo name to ingest (matches the `name` field
 *                               from `GET /api/repos`). If unset, every
 *                               registered repo is ingested.
 *   GITNEXUS_INCLUDE_CONTENT  — set to "true" to ask gitnexus to include file
 *                               source bodies in node properties. Default
 *                               false (saves a lot of space).
 *   GITNEXUS_NODE_LIMIT       — cap on nodes ingested per repo (safety net for
 *                               huge codebases). Default 20000.
 *   GITNEXUS_EDGE_LIMIT       — cap on edges ingested per repo. Default 50000.
 *
 *   GRAPH_API_URL             — base URL of the deployed Worker. When set the
 *                               ingested nodes/edges are also pushed to
 *                               POST {GRAPH_API_URL}/api/v1/public/ingest/graph.
 *   GRAPH_USER_ID             — userId passed to the Worker ingest endpoint.
 *                               Defaults to "local".
 *
 * Usage:
 *   node scripts/ingest-code.mjs
 *
 *   # Single repo, custom server, also push to the live Worker:
 *   GITNEXUS_URL=http://localhost:4747 \
 *   GITNEXUS_REPO=my-app \
 *   GRAPH_API_URL=https://graph.skdev-371.workers.dev \
 *     node scripts/ingest-code.mjs
 */

import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GraphBuilder, loadGraph, saveGraph, stableId } from './lib/graph-store.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const GRAPH_PATH = join(REPO_ROOT, 'data', 'graph.json');

const SOURCE_ID = 'code';

const GITNEXUS_URL = (process.env.GITNEXUS_URL || 'http://localhost:4747').replace(/\/$/, '');
const GITNEXUS_REPO = (process.env.GITNEXUS_REPO || '').trim() || null;
const INCLUDE_CONTENT = (process.env.GITNEXUS_INCLUDE_CONTENT || 'false').toLowerCase() === 'true';
const NODE_LIMIT = Math.max(1, Number(process.env.GITNEXUS_NODE_LIMIT || 20_000));
const EDGE_LIMIT = Math.max(1, Number(process.env.GITNEXUS_EDGE_LIMIT || 50_000));

const GRAPH_API_URL = (process.env.GRAPH_API_URL || '').replace(/\/$/, '');
const GRAPH_USER_ID = (process.env.GRAPH_USER_ID || '').trim() || 'local';

/**
 * gitnexus uses a fixed set of node labels (see NODE_TABLES in
 * gitnexus/src/server/api.ts). We translate each into a Graph node type and
 * decide a sensible default edge weight to use when it links to its file.
 */
const NODE_TYPE_PREFIX = 'code-';

function gnFetch(path, params = {}) {
  const url = new URL(`${GITNEXUS_URL}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    url.searchParams.set(k, String(v));
  }
  return fetch(url.toString(), { headers: { accept: 'application/json' } });
}

async function gnJson(path, params = {}) {
  let res;
  try {
    res = await gnFetch(path, params);
  } catch (err) {
    throw new Error(
      `Could not reach gitnexus at ${GITNEXUS_URL} (${err.message}). ` +
        `Start it with \`npx gitnexus@latest serve\` or set GITNEXUS_URL.`,
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`gitnexus ${path} → HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function checkHeartbeat() {
  try {
    await gnJson('/api/heartbeat');
  } catch (err) {
    // Surface a single, actionable message and exit non-zero.
    console.error(err.message);
    process.exit(1);
  }
}

async function listRepos() {
  const repos = await gnJson('/api/repos');
  return Array.isArray(repos) ? repos : [];
}

async function fetchRepoGraph(repoName) {
  return gnJson('/api/graph', { repo: repoName, includeContent: INCLUDE_CONTENT });
}

/**
 * Convert a gitnexus node label (e.g. "Function") into a Graph node type
 * (e.g. "code-function"). Unknown labels still get the prefix so they show up.
 */
function toGraphType(label) {
  const safe = String(label || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${NODE_TYPE_PREFIX}${safe || 'unknown'}`;
}

/**
 * Stable, repo-scoped id for a gitnexus node. gitnexus ids are unique within a
 * repo but we want to allow ingesting multiple repos into the same graph
 * without collisions, so we namespace by repo name.
 */
function namespacedId(repoName, gnId) {
  return stableId(SOURCE_ID, `${repoName}::${gnId}`);
}

function buildLabel(label, props) {
  const name = props?.name || '';
  const filePath = props?.filePath || '';
  if (label === 'File' || label === 'Folder') return filePath || name || label;
  if (props?.startLine != null && filePath) {
    return `${name || label}  (${filePath}:${props.startLine})`;
  }
  return name || filePath || label;
}

function ingestRepoGraph(builder, repoMeta, graph) {
  const repoId = stableId(SOURCE_ID, `repo:${repoMeta.name}`);
  builder.upsertNode({
    id: repoId,
    label: repoMeta.name,
    type: 'repo',
    sourceId: SOURCE_ID,
    sourceUrl: repoMeta.path ? `file://${repoMeta.path}` : undefined,
    metadata: {
      indexedAt: repoMeta.indexedAt,
      lastCommit: repoMeta.lastCommit,
      stats: repoMeta.stats,
      backend: 'gitnexus',
    },
  });

  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const rels = Array.isArray(graph?.relationships) ? graph.relationships : [];

  // Map gitnexus id → namespaced id, and remember which gitnexus ids were
  // actually emitted so we can skip dangling edges below.
  const idMap = new Map();
  // File nodes, keyed by gitnexus id, so we can wire DEFINED_IN edges.
  const filePathToGnId = new Map();

  let nodeCount = 0;
  for (const n of nodes) {
    if (nodeCount >= NODE_LIMIT) break;
    if (!n || !n.id) continue;
    const props = n.properties || {};
    const ourId = namespacedId(repoMeta.name, n.id);
    idMap.set(n.id, ourId);

    builder.upsertNode({
      id: ourId,
      label: buildLabel(n.label, props),
      type: toGraphType(n.label),
      sourceId: SOURCE_ID,
      metadata: {
        repo: repoMeta.name,
        gitnexusId: n.id,
        gitnexusLabel: n.label,
        name: props.name,
        filePath: props.filePath,
        startLine: props.startLine,
        endLine: props.endLine,
        // Pass a few useful gitnexus extras through verbatim.
        heuristicLabel: props.heuristicLabel,
        processType: props.processType,
        description: props.description,
      },
    });

    if (n.label === 'File') {
      // PART_OF edge: file → repo
      builder.upsertEdge({ source: ourId, target: repoId, relation: 'PART_OF', weight: 0.6 });
      if (props.filePath) filePathToGnId.set(props.filePath, n.id);
    }

    nodeCount += 1;
  }

  // Wire symbols → their containing file via DEFINED_IN where we can derive it
  // from `filePath`. gitnexus also emits explicit CONTAINS edges from File →
  // symbol; we keep both because the weights / direction are semantically
  // distinct (CONTAINS is structural, DEFINED_IN is the inverse view used by
  // the SPA's "where is X defined" hover).
  for (const n of nodes) {
    if (!n || !n.id || n.label === 'File' || n.label === 'Folder') continue;
    const props = n.properties || {};
    const ourId = idMap.get(n.id);
    if (!ourId) continue;
    const filePath = props.filePath;
    if (!filePath) continue;
    const fileGnId = filePathToGnId.get(filePath);
    if (!fileGnId) continue;
    const fileOurId = idMap.get(fileGnId);
    if (!fileOurId) continue;
    builder.upsertEdge({
      source: ourId,
      target: fileOurId,
      relation: 'DEFINED_IN',
      weight: 0.5,
    });
  }

  let edgeCount = 0;
  for (const r of rels) {
    if (edgeCount >= EDGE_LIMIT) break;
    if (!r || !r.sourceId || !r.targetId || !r.type) continue;
    const src = idMap.get(r.sourceId);
    const tgt = idMap.get(r.targetId);
    if (!src || !tgt) continue; // dangling edge — node was outside our cap
    const confidence = typeof r.confidence === 'number' ? r.confidence : 0.5;
    builder.upsertEdge({
      source: src,
      target: tgt,
      relation: String(r.type).toUpperCase(),
      weight: Math.max(0, Math.min(1, confidence)),
      metadata: {
        reason: r.reason,
        step: r.step,
        confidence,
      },
    });
    edgeCount += 1;
  }

  return { nodes: nodeCount, edges: edgeCount, repoId };
}

async function pushToWorker(nodes, edges) {
  const endpoint = `${GRAPH_API_URL}/api/v1/public/ingest/graph`;
  const CHUNK = 4_000; // mirror ingest-github.mjs

  const totalChunks = Math.ceil(nodes.length / CHUNK);
  console.log(
    `\nPushing to Worker: ${GRAPH_API_URL} (userId=${GRAPH_USER_ID}, ` +
      `${nodes.length} nodes in ${totalChunks} batch(es))`,
  );

  for (let i = 0; i < nodes.length; i += CHUNK) {
    const chunkNodes = nodes.slice(i, i + CHUNK);
    const chunkNodeIds = new Set(chunkNodes.map((n) => n.id));
    const chunkEdges = edges.filter(
      (e) => chunkNodeIds.has(e.source) && chunkNodeIds.has(e.target),
    );
    const batchNum = Math.floor(i / CHUNK) + 1;

    let res;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userId: GRAPH_USER_ID,
          sourceId: SOURCE_ID,
          nodes: chunkNodes,
          edges: chunkEdges,
        }),
      });
    } catch (err) {
      console.error(`  batch ${batchNum}/${totalChunks} — network error: ${err.message}`);
      continue;
    }

    if (res.ok) {
      let json;
      try {
        json = await res.json();
      } catch {
        json = {};
      }
      console.log(
        `  batch ${batchNum}/${totalChunks} — ok · total in Worker: ` +
          `${json.totalNodes ?? '?'} nodes / ${json.totalEdges ?? '?'} edges`,
      );
    } else {
      const text = await res.text().catch(() => '');
      console.error(
        `  batch ${batchNum}/${totalChunks} — HTTP ${res.status}: ${text.slice(0, 200)}`,
      );
    }
  }
}

async function main() {
  console.log(`Code ingester → gitnexus at ${GITNEXUS_URL}`);
  await checkHeartbeat();

  let repos = await listRepos();
  if (GITNEXUS_REPO) {
    repos = repos.filter((r) => r.name === GITNEXUS_REPO);
    if (repos.length === 0) {
      console.error(
        `Repo "${GITNEXUS_REPO}" not registered with gitnexus. ` +
          `Run \`gitnexus analyze <path>\` first, or check \`GET ${GITNEXUS_URL}/api/repos\`.`,
      );
      process.exit(1);
    }
  }

  if (repos.length === 0) {
    console.error(
      'gitnexus has no indexed repos. Run `gitnexus analyze <path>` against at ' +
        'least one repository before ingesting.',
    );
    process.exit(1);
  }

  console.log(`Found ${repos.length} indexed repo(s): ${repos.map((r) => r.name).join(', ')}`);

  const existing = await loadGraph(GRAPH_PATH);
  const builder = new GraphBuilder(existing);

  let totalNodes = 0;
  let totalEdges = 0;
  const repoStats = [];

  for (const repo of repos) {
    let graph;
    try {
      graph = await fetchRepoGraph(repo.name);
    } catch (err) {
      console.error(`  ${repo.name} — failed to fetch graph: ${err.message}`);
      continue;
    }
    const { nodes, edges } = ingestRepoGraph(builder, repo, graph);
    console.log(`  ${repo.name} — ${nodes} node(s), ${edges} edge(s)`);
    totalNodes += nodes;
    totalEdges += edges;
    repoStats.push({ repo: repo.name, nodes, edges });
  }

  builder.recordSource(SOURCE_ID, {
    repos: repoStats.length,
    nodes: totalNodes,
    edges: totalEdges,
    backend: 'gitnexus',
    backendUrl: GITNEXUS_URL,
  });

  await saveGraph(GRAPH_PATH, builder.graph);

  console.log(
    `\nIngested ${totalNodes} code node(s) · ${totalEdges} code edge(s) ` +
      `from ${repoStats.length} repo(s).`,
  );
  console.log(`Graph: ${builder.graph.nodes.length} nodes · ${builder.graph.edges.length} edges`);
  console.log(`Wrote ${GRAPH_PATH}`);

  if (GRAPH_API_URL) {
    await pushToWorker(builder.graph.nodes, builder.graph.edges);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
