/**
 * Pieces Desktop REST ingester (complement to ingest-pieces-mcp.mjs).
 *
 * Pulls structured artefacts directly from the Pieces OS HTTP API at
 * http://localhost:39300 — bypassing the MCP retrieval tools. Useful when:
 *
 *   - The MCP server isn't reachable (firewall, build mismatch).
 *   - You want concrete entities (conversations, workstream events, tags,
 *     applications) as their own graph nodes rather than free-text "memories"
 *     synthesised by `ask_pieces_ltm`.
 *   - You need reproducible runs — same input, same nodes — for diffing.
 *
 * Source ID is `pieces-rest` so it never clashes with the `pieces` source the
 * MCP ingester writes; you can run both and they'll layer cleanly.
 *
 * Endpoints used (confirmed against Pieces OS 1.0.x on Windows):
 *   GET /.well-known/health
 *   GET /conversations/identifiers
 *   GET /conversation/{id}
 *   GET /workstream_events/identifiers
 *   GET /workstream_event/{id}
 *   GET /tag/{id}
 *
 * Node types:
 *   pieces-rest-conversation      — one per saved Copilot chat
 *   pieces-rest-workstream-event  — one per auto-captured activity (OCR + app)
 *   pieces-rest-application       — source app behind a workstream event
 *   pieces-rest-tag               — tags applied to either of the above
 *
 * Edges:
 *   conversation -TAGGED_AS-> tag
 *   workstream   -CAPTURED_FROM-> application
 *   workstream   -TAGGED_AS-> tag
 *   workstream   -PART_OF-> conversation   (when grounded)
 *
 * Env:
 *   PIECES_REST_HOST       base url. Default http://localhost:39300
 *   PIECES_REST_MAX_EVENTS cap on workstream events ingested. Default 500
 *   PIECES_REST_INCLUDE_OCR set "1" to keep full OCR text in node metadata
 *                          (off by default; OCR can be very large)
 */

import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GraphBuilder, loadGraph, saveGraph, stableId } from './lib/graph-store.mjs';

const REPO_ROOT  = resolve(fileURLToPath(new URL('..', import.meta.url)));
const GRAPH_PATH = join(REPO_ROOT, 'data', 'graph.json');
const SOURCE_ID  = 'pieces-rest';

const HOST        = (process.env.PIECES_REST_HOST || 'http://localhost:39300').trim();
const MAX_EVENTS  = Math.max(1, Number(process.env.PIECES_REST_MAX_EVENTS || 500));
const INCLUDE_OCR = /^(1|true|yes)$/i.test(process.env.PIECES_REST_INCLUDE_OCR || '');
const CONCURRENCY = 8;

async function main() {
  console.log(`Pieces REST ingester → ${HOST}`);

  if (!(await isHealthy())) {
    console.error(
      `Pieces OS not reachable at ${HOST}/.well-known/health.\n` +
        'Start Pieces Desktop, or set PIECES_REST_HOST to a reachable URL.\n' +
        'For the MCP-based path instead, run `scripts/ingest-pieces-mcp.mjs`.',
    );
    process.exit(1);
  }

  const existing = await loadGraph(GRAPH_PATH);
  const builder  = new GraphBuilder(existing);
  const tagCache = new Map();   // pieces tag id -> { nodeId, label } | null
  const appCache = new Map();   // pieces app id -> graph node id

  const convIds  = await listIdentifiers('/conversations/identifiers');
  const eventIds = (await listIdentifiers('/workstream_events/identifiers')).slice(-MAX_EVENTS);

  console.log(
    `  ${convIds.length} conversation(s), ${eventIds.length} workstream event(s) ` +
      `(cap ${MAX_EVENTS}).`,
  );

  let convCount = 0, eventCount = 0;

  await pmap(convIds, CONCURRENCY, async (id) => {
    const c = await getJson(`/conversation/${id}`);
    if (!c) return;
    const convNodeId = stableId(SOURCE_ID, `conversation:${c.id}`);
    builder.upsertNode({
      id: convNodeId,
      label: c.name || `Conversation ${c.id.slice(0, 8)}`,
      type: 'pieces-rest-conversation',
      sourceId: SOURCE_ID,
      sourceUrl: `${HOST}/conversation/${c.id}`,
      createdAt: c.created?.value,
      metadata: {
        pieceId: c.id,
        kind: c.type,
        messages: countIndex(c.messages),
        annotations: countIndex(c.annotations),
        score: c.score,
        createdAt: c.created?.value,
        updatedAt: c.updated?.value,
      },
    });
    for (const tagId of indexKeys(c.tags)) {
      const tag = await resolveTag(builder, tagId, tagCache);
      if (!tag) continue;
      builder.upsertEdge({
        source: convNodeId, target: tag.nodeId, relation: 'TAGGED_AS', weight: 0.4,
      });
    }
    convCount += 1;
  });

  await pmap(eventIds, CONCURRENCY, async (id) => {
    const e = await getJson(`/workstream_event/${id}`);
    if (!e) return;
    const evNodeId = stableId(SOURCE_ID, `event:${e.id}`);
    const ocr = e.context?.native_ocr?.ocrText || '';
    builder.upsertNode({
      id: evNodeId,
      label: derivedEventLabel(e, ocr),
      type: 'pieces-rest-workstream-event',
      sourceId: SOURCE_ID,
      sourceUrl: `${HOST}/workstream_event/${e.id}`,
      createdAt: e.created?.value,
      metadata: {
        pieceId: e.id,
        application: e.application?.name,
        platform: e.application?.platform,
        privacy: e.application?.privacy,
        trigger: Object.keys(e.trigger || {}).join(',') || null,
        createdAt: e.created?.value,
        updatedAt: e.updated?.value,
        ocrPreview: ocr ? ocr.replace(/\s+/g, ' ').slice(0, 240) : null,
        ocrChars: ocr.length || 0,
        ...(INCLUDE_OCR && ocr ? { ocrText: ocr } : {}),
      },
    });

    if (e.application?.id) {
      let appNodeId = appCache.get(e.application.id);
      if (!appNodeId) {
        appNodeId = upsertApp(builder, e.application);
        appCache.set(e.application.id, appNodeId);
      }
      builder.upsertEdge({
        source: evNodeId, target: appNodeId, relation: 'CAPTURED_FROM', weight: 0.5,
      });
    }
    for (const tagId of indexKeys(e.tags)) {
      const tag = await resolveTag(builder, tagId, tagCache);
      if (!tag) continue;
      builder.upsertEdge({
        source: evNodeId, target: tag.nodeId, relation: 'TAGGED_AS', weight: 0.35,
      });
    }
    for (const cId of indexKeys(e.conversations)) {
      builder.upsertEdge({
        source: evNodeId,
        target: stableId(SOURCE_ID, `conversation:${cId}`),
        relation: 'PART_OF',
        weight: 0.5,
      });
    }
    eventCount += 1;
  });

  const tagCount = [...tagCache.values()].filter(Boolean).length;

  builder.recordSource(SOURCE_ID, {
    host: HOST,
    conversations: convCount,
    workstreamEvents: eventCount,
    tags: tagCount,
    applications: appCache.size,
    capEvents: MAX_EVENTS,
  });
  await saveGraph(GRAPH_PATH, builder.graph);

  console.log(
    `\nIngested ${convCount} conversation(s), ${eventCount} workstream event(s), ` +
      `${tagCount} tag(s), ${appCache.size} application(s).`,
  );
  console.log(`Graph: ${builder.graph.nodes.length} nodes · ${builder.graph.edges.length} edges`);
  console.log(`Wrote ${GRAPH_PATH}`);
}

function upsertApp(builder, app) {
  const id = stableId(SOURCE_ID, `application:${app.name}::${app.platform}`);
  builder.upsertNode({
    id,
    label: prettyAppName(app.name),
    type: 'pieces-rest-application',
    sourceId: SOURCE_ID,
    metadata: {
      name: app.name,
      platform: app.platform,
      version: app.version,
      privacy: app.privacy,
      mechanism: app.mechanism,
    },
  });
  return id;
}

async function resolveTag(builder, tagId, cache) {
  if (cache.has(tagId)) return cache.get(tagId);
  const t = await getJson(`/tag/${tagId}`);
  if (!t || !t.text) { cache.set(tagId, null); return null; }
  const nodeId = stableId(SOURCE_ID, `tag:${t.text.toLowerCase()}`);
  builder.upsertNode({
    id: nodeId,
    label: t.text,
    type: 'pieces-rest-tag',
    sourceId: SOURCE_ID,
    metadata: { text: t.text, category: t.category, references: t.score?.reference ?? 0 },
  });
  const out = { nodeId, label: t.text };
  cache.set(tagId, out);
  return out;
}

function countIndex(obj) {
  if (!obj) return 0;
  if (Array.isArray(obj.iterable) && obj.iterable.length) return obj.iterable.length;
  if (obj.indices && typeof obj.indices === 'object') return Object.keys(obj.indices).length;
  return 0;
}

function indexKeys(obj) {
  if (!obj) return [];
  if (obj.indices && typeof obj.indices === 'object') return Object.keys(obj.indices);
  if (Array.isArray(obj.iterable)) return obj.iterable.map((x) => x?.id).filter(Boolean);
  return [];
}

function derivedEventLabel(e, ocr) {
  if (ocr) {
    const firstLine = ocr.split('\n').map((s) => s.trim()).find((s) => s.length >= 4);
    if (firstLine) return truncate(firstLine, 80);
  }
  const app = prettyAppName(e.application?.name) || 'app';
  return `${app} · ${(e.created?.readable || e.id.slice(0, 8))}`;
}

function prettyAppName(name) {
  if (!name) return null;
  return name.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function truncate(s, n) {
  if (typeof s !== 'string') return s;
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

async function isHealthy() {
  try {
    const r = await fetch(`${HOST}/.well-known/health`, { signal: AbortSignal.timeout(2500) });
    return r.ok;
  } catch { return false; }
}

async function listIdentifiers(path) {
  const j = await getJson(path);
  if (!j) return [];
  return (j.iterable || []).map((x) => x?.id).filter(Boolean);
}

async function getJson(path) {
  try {
    const r = await fetch(`${HOST}${path}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function pmap(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { await fn(items[idx], idx); }
      catch (err) { console.error(`Pieces item ${items[idx]} failed:`, err.message); }
    }
  });
  await Promise.all(workers);
}

main().catch((err) => { console.error(err); process.exit(1); });
