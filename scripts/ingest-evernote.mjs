/**
 * Evernote ENEX ingester (v1).
 *
 * Parses one or more Evernote export files (.enex) and ingests their notes
 * into the knowledge graph as `note` nodes.
 *
 * Each note produces:
 *  - A `note` node with title, creation/update timestamps, and a plain-text
 *    excerpt of the ENML body.
 *  - `tag` nodes for every Evernote tag.
 *  - `TAGGED_WITH` edges from the note to each tag.
 *  - A `concept` node for the notebook, with a `PART_OF` edge.
 *
 * ENEX is a well-defined XML format; this ingester uses only Node's built-in
 * string processing — no third-party XML parser is required.
 *
 * Configuration (env vars):
 *   ENEX_FILE   — path to a single .enex file (or colon-separated list).
 *   ENEX_DIR    — directory to scan recursively for *.enex files.
 *
 * Positional arguments (paths to .enex files) are also accepted:
 *   node scripts/ingest-evernote.mjs ~/export.enex ~/second.enex
 *
 * Usage:
 *   ENEX_FILE=~/Documents/MyNotes.enex node scripts/ingest-evernote.mjs
 *   ENEX_DIR=~/EvernoteExports node scripts/ingest-evernote.mjs
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GraphBuilder, loadGraph, saveGraph, stableId } from './lib/graph-store.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const GRAPH_PATH = join(REPO_ROOT, 'data', 'graph.json');

const SOURCE_ID = 'evernote';
const MAX_EXCERPT_CHARS = 500;
const MAX_DEPTH = 4;

async function findEnexFiles(dir, depth, out) {
  if (depth < 0) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await findEnexFiles(full, depth - 1, out);
    } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.enex') {
      out.push(full);
    }
  }
}

async function resolveEnexPaths() {
  const paths = [];

  // Positional CLI args
  for (const arg of process.argv.slice(2)) {
    if (!arg.startsWith('-')) paths.push(resolve(arg));
  }

  // Env: colon-separated file list
  if (process.env.ENEX_FILE) {
    for (const p of process.env.ENEX_FILE.split(':')) {
      const trimmed = p.trim();
      if (trimmed) paths.push(resolve(trimmed));
    }
  }

  // Env: directory scan
  if (process.env.ENEX_DIR) {
    await findEnexFiles(resolve(process.env.ENEX_DIR), MAX_DEPTH, paths);
  }

  return [...new Set(paths)];
}

/**
 * Extract the text content of a simple XML element (first occurrence).
 * Returns null if the tag is absent.
 */
function extractXmlText(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = re.exec(xml);
  if (!m) return null;
  return decodeXmlEntities(m[1].trim());
}

/**
 * Extract all occurrences of a simple XML element as an array of strings.
 */
function extractXmlAll(xml, tag) {
  const results = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  let m;
  while ((m = re.exec(xml)) !== null) {
    const text = decodeXmlEntities(m[1].trim());
    if (text) results.push(text);
  }
  return results;
}

function decodeXmlEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#xA;/gi, '\n')
    .replace(/&#10;/g, '\n')
    .replace(/&amp;/g, '&'); // &amp; must be decoded last to avoid double-decode
}

/**
 * Strip ENML (Evernote's HTML-based format) to plain text.
 */
function enmlToText(enml) {
  return enml
    .replace(/<script[\s\S]*?<\/\s*script\s*>/gi, '')
    .replace(/<style[\s\S]*?<\/\s*style\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse an ENEX XML string into an array of note objects.
 */
function parseEnex(xml, filePath) {
  const notes = [];
  const noteBlocks = [];
  const noteRe = /<note>([\s\S]*?)<\/note>/gi;
  let m;
  while ((m = noteRe.exec(xml)) !== null) {
    noteBlocks.push(m[1]);
  }

  for (const block of noteBlocks) {
    const title = extractXmlText(block, 'title') || '(untitled)';
    const created = parseEnexDate(extractXmlText(block, 'created'));
    const updated = parseEnexDate(extractXmlText(block, 'updated'));
    const notebook = extractXmlText(block, 'stack') || null;
    const tags = extractXmlAll(block, 'tag');

    // ENML content is wrapped in a <content> element which itself contains
    // a CDATA section with the ENML body.
    const contentMatch = /<content>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/content>/i.exec(block);
    const rawContent = contentMatch ? contentMatch[1] : '';
    const plainText = enmlToText(rawContent);

    notes.push({ title, created, updated, notebook, tags, plainText, filePath });
  }
  return notes;
}

/**
 * Parse Evernote date format (YYYYMMDDTHHmmssZ) into ISO-8601.
 */
function parseEnexDate(raw) {
  if (!raw) return null;
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(raw);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
}

async function main() {
  const enexPaths = await resolveEnexPaths();

  if (enexPaths.length === 0) {
    console.error(
      'No ENEX files found.\n' +
      'Usage: node scripts/ingest-evernote.mjs /path/to/file.enex\n' +
      '  or set ENEX_FILE=/path/to/file.enex or ENEX_DIR=/path/to/exports/',
    );
    process.exit(1);
  }

  console.log(`Parsing ${enexPaths.length} ENEX file(s)...`);

  const existing = await loadGraph(GRAPH_PATH);
  const builder = new GraphBuilder(existing);

  let notesIngested = 0;
  const tagsCreated = new Set();
  const notebooksCreated = new Set();

  for (const filePath of enexPaths) {
    let xml;
    try {
      xml = await readFile(filePath, 'utf8');
    } catch (err) {
      console.warn(`  Skipping ${filePath}: ${err.message}`);
      continue;
    }

    const notes = parseEnex(xml, filePath);
    console.log(`  ${filePath}: ${notes.length} note(s)`);

    for (const note of notes) {
      const noteId = stableId(SOURCE_ID, `${filePath}::${note.title}`);
      const excerpt = note.plainText.slice(0, MAX_EXCERPT_CHARS);

      builder.upsertNode({
        id: noteId,
        label: note.title.slice(0, 200),
        type: 'note',
        sourceId: SOURCE_ID,
        createdAt: note.created || undefined,
        metadata: {
          filePath,
          excerpt,
          notebook: note.notebook,
          tags: note.tags,
          wordCount: note.plainText.split(/\s+/).filter(Boolean).length,
        },
      });
      notesIngested += 1;

      // Tag nodes
      for (const tag of note.tags) {
        const normTag = tag.trim().toLowerCase();
        if (!normTag) continue;
        const tagId = stableId('tag', normTag);
        builder.upsertNode({
          id: tagId,
          label: `#${normTag}`,
          type: 'tag',
          sourceId: SOURCE_ID,
          metadata: { tag: normTag },
        });
        builder.upsertEdge({
          source: noteId,
          target: tagId,
          relation: 'TAGGED_WITH',
          weight: 0.4,
        });
        tagsCreated.add(normTag);
      }

      // Notebook concept node
      if (note.notebook) {
        const nbId = stableId('concept', `evernote-notebook:${note.notebook}`);
        builder.upsertNode({
          id: nbId,
          label: note.notebook,
          type: 'concept',
          sourceId: SOURCE_ID,
          metadata: { notebookName: note.notebook },
        });
        builder.upsertEdge({
          source: noteId,
          target: nbId,
          relation: 'PART_OF',
          weight: 0.5,
        });
        notebooksCreated.add(note.notebook);
      }
    }
  }

  builder.recordSource(SOURCE_ID, {
    notes: notesIngested,
    tags: tagsCreated.size,
    notebooks: notebooksCreated.size,
  });

  await saveGraph(GRAPH_PATH, builder.graph);

  console.log(
    `Ingested ${notesIngested} note(s) · ${tagsCreated.size} tag(s) · ${notebooksCreated.size} notebook(s).`,
  );
  console.log(`Graph: ${builder.graph.nodes.length} nodes · ${builder.graph.edges.length} edges`);
  console.log(`Wrote ${GRAPH_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
