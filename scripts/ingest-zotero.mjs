/**
 * Zotero ingester (v1).
 *
 * Fetches items from the Zotero Web API and ingests them into the knowledge
 * graph as `document` nodes (academic papers, books, web pages, etc.).
 *
 * Each item produces:
 *  - A `document` node with title, abstract, DOI, URL, date, and item type.
 *  - `person` nodes for every creator (author/editor).
 *  - `AUTHORED_BY` edges from the document to each creator.
 *  - `tag` nodes for every Zotero tag.
 *  - `TAGGED_WITH` edges from the document to each tag.
 *  - `PART_OF` edge to a `concept` node representing the Zotero collection
 *    (if the item belongs to one).
 *
 * Configuration (env vars):
 *   ZOTERO_USER_ID   — numeric Zotero user ID (required).
 *   ZOTERO_API_KEY   — Zotero API key with read access (required).
 *   ZOTERO_GROUP_ID  — optional; ingest from a group library instead of the
 *                      personal library.
 *   ZOTERO_LIMIT     — max items to fetch per run (default: 200).
 *
 * Usage:
 *   ZOTERO_USER_ID=1234567 ZOTERO_API_KEY=abc123 node scripts/ingest-zotero.mjs
 *
 * Docs: https://www.zotero.org/support/dev/web_api/v3/basics
 */

import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GraphBuilder, loadGraph, saveGraph, stableId } from './lib/graph-store.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const GRAPH_PATH = join(REPO_ROOT, 'data', 'graph.json');

const SOURCE_ID = 'zotero';
const BASE_URL = 'https://api.zotero.org';
const API_VERSION = '3';

const USER_ID = process.env.ZOTERO_USER_ID;
const API_KEY = process.env.ZOTERO_API_KEY;
const GROUP_ID = process.env.ZOTERO_GROUP_ID;
const MAX_ITEMS = Number(process.env.ZOTERO_LIMIT || 200);
const PAGE_SIZE = 50; // Zotero's max page size

if (!USER_ID || !API_KEY) {
  console.error(
    'Missing required env vars: ZOTERO_USER_ID and ZOTERO_API_KEY must be set.\n' +
    'Find your user ID at https://www.zotero.org/settings/keys',
  );
  process.exit(1);
}

const libraryPath = GROUP_ID
  ? `/groups/${GROUP_ID}`
  : `/users/${USER_ID}`;

async function zoteroFetch(path, params = {}) {
  const url = new URL(`${BASE_URL}${libraryPath}${path}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), {
    headers: {
      'Zotero-API-Key': API_KEY,
      'Zotero-API-Version': API_VERSION,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Zotero API error ${res.status}: ${text.slice(0, 200)}`);
  }
  return { json: await res.json(), total: Number(res.headers.get('Total-Results') ?? 0) };
}

async function fetchAllItems() {
  const items = [];
  let start = 0;
  while (items.length < MAX_ITEMS) {
    const limit = Math.min(PAGE_SIZE, MAX_ITEMS - items.length);
    const { json, total } = await zoteroFetch('/items', {
      itemType: '-attachment',
      start,
      limit,
      sort: 'dateModified',
      direction: 'desc',
    });
    if (!Array.isArray(json) || json.length === 0) break;
    items.push(...json);
    start += json.length;
    if (start >= total) break;
  }
  return items;
}

function creatorName(creator) {
  if (creator.name) return creator.name.trim();
  const parts = [creator.firstName, creator.lastName].filter(Boolean);
  return parts.join(' ').trim() || 'Unknown';
}

async function main() {
  console.log(`Fetching Zotero items for ${GROUP_ID ? `group ${GROUP_ID}` : 'personal library'}...`);

  let rawItems;
  try {
    rawItems = await fetchAllItems();
  } catch (err) {
    console.error(`Failed to fetch Zotero items: ${err.message}`);
    process.exit(1);
  }

  console.log(`Fetched ${rawItems.length} item(s) from Zotero.`);

  const existing = await loadGraph(GRAPH_PATH);
  const builder = new GraphBuilder(existing);

  let docsIngested = 0;
  let creatorsCreated = new Set();
  let tagsCreated = new Set();

  for (const item of rawItems) {
    const data = item.data;
    if (!data || !data.key) continue;

    const title = (data.title || '(untitled)').trim().slice(0, 200);
    const itemId = stableId(SOURCE_ID, data.key);

    const docNode = builder.upsertNode({
      id: itemId,
      label: title,
      type: 'document',
      sourceId: SOURCE_ID,
      sourceUrl: data.url || (data.DOI ? `https://doi.org/${data.DOI}` : undefined),
      createdAt: data.dateAdded || undefined,
      metadata: {
        itemType: data.itemType,
        abstractNote: data.abstractNote ? data.abstractNote.slice(0, 500) : undefined,
        doi: data.DOI || undefined,
        url: data.url || undefined,
        date: data.date || undefined,
        publicationTitle: data.publicationTitle || undefined,
        volume: data.volume || undefined,
        pages: data.pages || undefined,
        zoteroKey: data.key,
        zoteroVersion: item.version,
        collections: data.collections || [],
      },
    });

    docsIngested += 1;

    // Creator nodes and AUTHORED_BY edges
    for (const creator of (data.creators || [])) {
      const name = creatorName(creator);
      if (!name || name === 'Unknown') continue;
      const creatorId = stableId('person', name.toLowerCase());
      builder.upsertNode({
        id: creatorId,
        label: name,
        type: 'person',
        sourceId: SOURCE_ID,
        metadata: { creatorType: creator.creatorType },
      });
      builder.upsertEdge({
        source: docNode.id,
        target: creatorId,
        relation: 'AUTHORED_BY',
        weight: creator.creatorType === 'author' ? 0.8 : 0.5,
      });
      creatorsCreated.add(name);
    }

    // Tag nodes and TAGGED_WITH edges
    for (const { tag } of (data.tags || [])) {
      if (!tag || !tag.trim()) continue;
      const normTag = tag.trim().toLowerCase();
      const tagId = stableId('tag', normTag);
      builder.upsertNode({
        id: tagId,
        label: `#${normTag}`,
        type: 'tag',
        sourceId: SOURCE_ID,
        metadata: { tag: normTag },
      });
      builder.upsertEdge({
        source: docNode.id,
        target: tagId,
        relation: 'TAGGED_WITH',
        weight: 0.4,
      });
      tagsCreated.add(normTag);
    }

    // Collection nodes and PART_OF edges
    for (const collectionKey of (data.collections || [])) {
      const collId = stableId('concept', `zotero-collection:${collectionKey}`);
      builder.upsertNode({
        id: collId,
        label: `Zotero Collection ${collectionKey}`,
        type: 'concept',
        sourceId: SOURCE_ID,
        metadata: { zoteroCollectionKey: collectionKey },
      });
      builder.upsertEdge({
        source: docNode.id,
        target: collId,
        relation: 'PART_OF',
        weight: 0.5,
      });
    }
  }

  builder.recordSource(SOURCE_ID, {
    documents: docsIngested,
    creators: creatorsCreated.size,
    tags: tagsCreated.size,
  });

  await saveGraph(GRAPH_PATH, builder.graph);

  console.log(
    `Ingested ${docsIngested} document(s) · ${creatorsCreated.size} creator(s) · ${tagsCreated.size} tag(s).`,
  );
  console.log(`Graph: ${builder.graph.nodes.length} nodes · ${builder.graph.edges.length} edges`);
  console.log(`Wrote ${GRAPH_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
