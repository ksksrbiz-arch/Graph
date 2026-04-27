/**
 * Browser bookmarks ingester (v1).
 *
 * Parses a Netscape HTML bookmark export (the standard format used by Chrome,
 * Firefox, Edge, and Safari) and ingests each bookmark as a `bookmark` node.
 *
 * Each bookmark produces:
 *  - A `bookmark` node (title, URL, add-date timestamp).
 *  - A `concept` node for the folder path.
 *  - A `PART_OF` edge from the bookmark to the folder concept.
 *
 * Configuration (env vars):
 *   BOOKMARKS_FILE  — path to an HTML bookmarks export (required).
 *
 * Positional argument is also accepted:
 *   node scripts/ingest-bookmarks.mjs ~/bookmarks.html
 *
 * Usage:
 *   node scripts/ingest-bookmarks.mjs ~/Downloads/bookmarks.html
 *   BOOKMARKS_FILE=~/bookmarks.html node scripts/ingest-bookmarks.mjs
 */

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GraphBuilder, loadGraph, saveGraph, stableId } from './lib/graph-store.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const GRAPH_PATH = join(REPO_ROOT, 'data', 'graph.json');

const SOURCE_ID = 'bookmarks';

async function resolveBookmarksPath() {
  // CLI positional arg
  const arg = process.argv.slice(2).find((a) => !a.startsWith('-'));
  if (arg) return resolve(arg);
  if (process.env.BOOKMARKS_FILE) return resolve(process.env.BOOKMARKS_FILE.trim());
  return null;
}

/**
 * Parse a Netscape HTML bookmark file.
 * Returns an array of { title, url, addDate, folder } objects.
 */
function parseBookmarksHtml(html) {
  const bookmarks = [];
  const folderStack = [];

  // Iterate over all <DT> entries — each is either a folder <H3> or a link <A>
  const dtRe = /<DT>([\s\S]*?)(?=<DT>|<\/DL>|$)/gi;
  const h3Re = /<H3[^>]*>([\s\S]*?)<\/H3>/i;
  const aRe = /<A\s+([^>]+)>([\s\S]*?)<\/A>/i;
  const attrRe = /(\w[\w-]*)=["']([^"']*)["']/gi;

  // Pre-process: extract folder context by looking at <DL> nesting
  // Simple approach: scan line by line
  const lines = html.split('\n');
  let currentFolder = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Track folder entries
    if (/<H3/i.test(trimmed)) {
      const titleMatch = /<H3[^>]*>([\s\S]*?)<\/H3>/i.exec(trimmed);
      const folderName = titleMatch ? stripTags(titleMatch[1]) : 'Unknown';
      currentFolder.push(folderName);
    } else if (/<\/DL>/i.test(trimmed)) {
      currentFolder.pop();
    } else if (/<A\s+/i.test(trimmed)) {
      const aMatch = /<A\s+([^>]+)>([\s\S]*?)<\/A>/i.exec(trimmed);
      if (!aMatch) continue;
      const attrsStr = aMatch[1];
      const title = stripTags(aMatch[2]).trim() || '(untitled)';

      const attrs = {};
      const attrPattern = /(\w[\w-]*)=["']([^"']*)["']/gi;
      let attrM;
      while ((attrM = attrPattern.exec(attrsStr)) !== null) {
        attrs[attrM[1].toUpperCase()] = attrM[2];
      }
      const url = attrs.HREF;
      if (!url || !url.startsWith('http')) continue;

      const addDateRaw = attrs.ADD_DATE;
      let addDate;
      if (addDateRaw) {
        const ts = Number(addDateRaw);
        addDate = !Number.isNaN(ts) ? new Date(ts * 1000).toISOString() : undefined;
      }

      bookmarks.push({
        title: title.slice(0, 200),
        url,
        addDate,
        folder: [...currentFolder],
      });
    }
  }

  return bookmarks;
}

function stripTags(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')  // decode &amp; last to avoid double-decode of &amp;lt; etc.
    .replace(/<[^>]*>/g, '')  // strip any tags that were entity-encoded
    .trim();
}

async function main() {
  const filePath = await resolveBookmarksPath();
  if (!filePath) {
    console.error(
      'No bookmarks file specified.\n' +
      'Usage: node scripts/ingest-bookmarks.mjs /path/to/bookmarks.html\n' +
      '  or set BOOKMARKS_FILE=/path/to/bookmarks.html',
    );
    process.exit(1);
  }

  let html;
  try {
    html = await readFile(filePath, 'utf8');
  } catch (err) {
    console.error(`Cannot read file: ${err.message}`);
    process.exit(1);
  }

  console.log(`Parsing bookmarks from ${filePath}...`);

  const bookmarks = parseBookmarksHtml(html);
  console.log(`Found ${bookmarks.length} bookmark(s).`);

  if (bookmarks.length === 0) {
    console.log('Nothing to ingest.');
    return;
  }

  const existing = await loadGraph(GRAPH_PATH);
  const builder = new GraphBuilder(existing);

  let ingested = 0;
  const foldersCreated = new Set();

  for (const bm of bookmarks) {
    const nodeId = stableId(SOURCE_ID, bm.url);
    builder.upsertNode({
      id: nodeId,
      label: bm.title,
      type: 'bookmark',
      sourceId: SOURCE_ID,
      sourceUrl: bm.url,
      createdAt: bm.addDate,
      metadata: { url: bm.url, folder: bm.folder.join(' / ') || undefined },
    });
    ingested += 1;

    // Folder hierarchy concept node
    if (bm.folder.length > 0) {
      const folderPath = bm.folder.join(' / ');
      const folderId = stableId('concept', `bookmark-folder:${folderPath}`);
      builder.upsertNode({
        id: folderId,
        label: bm.folder[bm.folder.length - 1],
        type: 'concept',
        sourceId: SOURCE_ID,
        metadata: { folderPath },
      });
      builder.upsertEdge({ source: nodeId, target: folderId, relation: 'PART_OF', weight: 0.5 });
      foldersCreated.add(folderPath);
    }
  }

  builder.recordSource(SOURCE_ID, { bookmarks: ingested, folders: foldersCreated.size });
  await saveGraph(GRAPH_PATH, builder.graph);

  console.log(`Ingested ${ingested} bookmark(s) across ${foldersCreated.size} folder(s).`);
  console.log(`Graph: ${builder.graph.nodes.length} nodes · ${builder.graph.edges.length} edges`);
  console.log(`Wrote ${GRAPH_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
