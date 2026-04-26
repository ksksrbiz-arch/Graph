/**
 * Markdown notes ingester.
 *
 * Discovers local Markdown files (e.g. an Obsidian vault, a ~/notes folder,
 * or any collection of .md files) and ingests them into the knowledge graph
 * as `note` nodes.  The following are extracted automatically:
 *
 *  - YAML frontmatter: title, date, tags, aliases
 *  - Inline `#hashtags`
 *  - `[[wikilinks]]` between notes
 *  - Plain `[text](url)` links stored as metadata
 *
 * Contextual connections to the rest of the graph:
 *  - Notes whose `title` or filename matches an existing `project` node label
 *    receive a `RELATED_TO` edge.
 *  - Notes that reference a filename matching an existing `file` node receive
 *    a `MENTIONS` edge to that file.
 *
 * Configuration (env vars):
 *   NOTES_DIR — colon-separated list of directories to scan (default: the
 *               first of ~/Documents/notes, ~/notes, ~/Obsidian, ~/Documents
 *               that exists).
 *   NOTES_MAX_DEPTH — directory depth limit (default: 6).
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GraphBuilder, loadGraph, saveGraph, stableId } from './lib/graph-store.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const GRAPH_PATH = join(REPO_ROOT, 'data', 'graph.json');

const SOURCE_ID = 'markdown';
const MAX_DEPTH = Number(process.env.NOTES_MAX_DEPTH || 6);

const DEFAULT_CANDIDATE_DIRS = [
  join(homedir(), 'Documents', 'notes'),
  join(homedir(), 'notes'),
  join(homedir(), 'Obsidian'),
  join(homedir(), 'Documents'),
];

async function resolveNotesDirs() {
  if (process.env.NOTES_DIR) {
    return process.env.NOTES_DIR.split(':').map((p) => p.trim()).filter(Boolean);
  }
  for (const dir of DEFAULT_CANDIDATE_DIRS) {
    try {
      const s = await stat(dir);
      if (s.isDirectory()) return [dir];
    } catch { /* not found */ }
  }
  return [];
}

async function main() {
  const notesDirs = await resolveNotesDirs();
  if (notesDirs.length === 0) {
    console.error(
      'No notes directory found. Set NOTES_DIR to the path of your notes/Obsidian vault.',
    );
    process.exit(1);
  }

  console.log(`Scanning for Markdown notes in: ${notesDirs.join(', ')}`);

  const mdFiles = [];
  for (const dir of notesDirs) {
    await findMarkdownFiles(dir, MAX_DEPTH, mdFiles);
  }

  if (mdFiles.length === 0) {
    console.log('No Markdown files found.');
    process.exit(0);
  }

  console.log(`Found ${mdFiles.length} Markdown file(s).`);

  const existing = await loadGraph(GRAPH_PATH);
  const builder = new GraphBuilder(existing);

  // Build lookup indexes over existing nodes for contextual linking.
  const projectNodeByLabel = new Map();
  for (const node of existing.nodes) {
    if (node.type === 'project') {
      projectNodeByLabel.set(node.label.toLowerCase(), node.id);
    }
  }
  const fileNodeByBasename = new Map();
  for (const node of existing.nodes) {
    if (node.type === 'file' && node.metadata?.path) {
      fileNodeByBasename.set(basename(node.metadata.path).toLowerCase(), node.id);
    }
  }

  // First pass: parse every file and build a title→nodeId map for wikilinks.
  const parsedNotes = [];
  const noteTitleToId = new Map(); // normalised title → nodeId

  for (const filePath of mdFiles) {
    const parsed = await parseMarkdownFile(filePath);
    if (!parsed) continue;
    parsedNotes.push(parsed);
    noteTitleToId.set(parsed.title.toLowerCase(), stableId('note', filePath));
    // Also register by filename stem so [[filename]] wikilinks resolve.
    const stem = basename(filePath, extname(filePath)).toLowerCase();
    if (!noteTitleToId.has(stem)) {
      noteTitleToId.set(stem, stableId('note', filePath));
    }
  }

  // Second pass: upsert nodes and edges.
  let notesIngested = 0;
  let tagsCreated = new Set();

  for (const note of parsedNotes) {
    const noteId = stableId('note', note.filePath);

    builder.upsertNode({
      id: noteId,
      label: note.title,
      type: 'note',
      sourceId: SOURCE_ID,
      createdAt: note.date || undefined,
      metadata: {
        path: note.filePath,
        wordCount: note.wordCount,
        tags: note.tags,
        aliases: note.aliases,
        outboundLinks: note.urls,
      },
    });

    notesIngested += 1;

    // Tag nodes
    for (const tag of note.tags) {
      const tagId = stableId('tag', tag);
      builder.upsertNode({
        id: tagId,
        label: `#${tag}`,
        type: 'tag',
        sourceId: SOURCE_ID,
        metadata: { tag },
      });
      builder.upsertEdge({
        source: noteId,
        target: tagId,
        relation: 'TAGGED',
        weight: 0.5,
      });
      tagsCreated.add(tag);
    }

    // Wikilinks → note→note edges
    for (const link of note.wikilinks) {
      const targetId = noteTitleToId.get(link.toLowerCase());
      if (targetId && targetId !== noteId) {
        builder.upsertEdge({
          source: noteId,
          target: targetId,
          relation: 'LINKS_TO',
          weight: 0.6,
        });
      }
    }

    // Contextual: link to matching project node
    const projectMatch = projectNodeByLabel.get(note.title.toLowerCase());
    if (projectMatch) {
      builder.upsertEdge({
        source: noteId,
        target: projectMatch,
        relation: 'RELATED_TO',
        weight: 0.5,
        metadata: { reason: 'title-matches-project' },
      });
    }

    // Contextual: link to file nodes mentioned by wikilinks (e.g. [[app.js]])
    for (const link of note.wikilinks) {
      const fileMatch = fileNodeByBasename.get(link.toLowerCase());
      if (fileMatch) {
        builder.upsertEdge({
          source: noteId,
          target: fileMatch,
          relation: 'MENTIONS',
          weight: 0.35,
        });
      }
    }
  }

  builder.recordSource(SOURCE_ID, {
    notes: notesIngested,
    tags: tagsCreated.size,
  });

  await saveGraph(GRAPH_PATH, builder.graph);

  console.log(`Ingested ${notesIngested} note(s) · ${tagsCreated.size} unique tag(s).`);
  console.log(`Graph: ${builder.graph.nodes.length} nodes · ${builder.graph.edges.length} edges`);
  console.log(`Wrote ${GRAPH_PATH}`);
}

async function findMarkdownFiles(dir, depth, out) {
  if (depth < 0) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      await findMarkdownFiles(join(dir, entry.name), depth - 1, out);
    } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') {
      out.push(join(dir, entry.name));
    }
  }
}

/**
 * Parse a single Markdown file, returning structured data.
 */
async function parseMarkdownFile(filePath) {
  let text;
  try {
    text = await readFile(filePath, 'utf8');
  } catch {
    return null;
  }

  const { frontmatter, body } = splitFrontmatter(text);
  const fm = parseFrontmatter(frontmatter);

  const title = fm.title || basename(filePath, extname(filePath));
  const date = fm.date ? String(fm.date) : null;

  // Collect tags from frontmatter and inline #hashtags
  const tags = new Set(normaliseTags(fm.tags));
  for (const match of body.matchAll(/#([\w/-]+)/g)) {
    tags.add(match[1].toLowerCase());
  }

  // Extract [[wikilinks]]
  const wikilinks = [];
  for (const match of body.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
    wikilinks.push(match[1].trim());
  }

  // Extract plain URLs from [text](url) links
  const urls = [];
  for (const match of body.matchAll(/\[[^\]]*\]\((https?:\/\/[^)]+)\)/g)) {
    urls.push(match[1]);
  }

  const wordCount = body.split(/\s+/).filter(Boolean).length;

  const aliases = normaliseTags(fm.aliases || fm.alias);

  return { filePath, title, date, tags: [...tags], wikilinks, urls, wordCount, aliases };
}

/**
 * Split YAML frontmatter (--- ... ---) from body.
 */
function splitFrontmatter(text) {
  if (!text.startsWith('---')) return { frontmatter: '', body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { frontmatter: '', body: text };
  return {
    frontmatter: text.slice(3, end).trim(),
    body: text.slice(end + 4),
  };
}

/**
 * Minimal YAML frontmatter parser (handles simple key: value and key: [a, b]).
 * Does not handle nested objects — sufficient for typical note frontmatter.
 */
function parseFrontmatter(yaml) {
  const result = {};
  if (!yaml) return result;
  for (const line of yaml.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const raw = line.slice(colonIdx + 1).trim();
    if (!key) continue;
    if (raw.startsWith('[')) {
      // Inline array: [a, b, c]
      result[key] = raw
        .slice(1, raw.lastIndexOf(']'))
        .split(',')
        .map((v) => v.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
    } else {
      result[key] = raw.replace(/^['"]|['"]$/g, '');
    }
  }
  return result;
}

function normaliseTags(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((v) => String(v).toLowerCase().trim()).filter(Boolean);
  return String(value).split(',').map((v) => v.trim().toLowerCase()).filter(Boolean);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
