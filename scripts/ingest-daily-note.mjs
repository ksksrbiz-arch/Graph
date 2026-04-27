/**
 * Daily-note template generator (v1).
 *
 * Creates a new daily note for today (or a given date) in a configurable
 * notes directory and ingests it into the knowledge graph as a `note` node.
 * If a note for the same date already exists it is updated idempotently.
 *
 * The generated note uses a Markdown template with:
 *  - YAML frontmatter (date, tags, mood)
 *  - Sections for meetings, ideas, journal, and tasks
 *  - Automatic wikilink to the previous day's note
 *
 * After writing the file the ingester behaves identically to
 * ingest-markdown.mjs so the new note appears in the graph immediately.
 *
 * Configuration (env vars):
 *   DAILY_NOTES_DIR  — directory where daily notes are stored.
 *                      Default: first of ~/Documents/notes/daily, ~/notes/daily,
 *                      ~/Obsidian/daily, ~/Documents/daily that exists (or the
 *                      first candidate that can be created).
 *   DAILY_DATE       — ISO date to generate (YYYY-MM-DD). Default: today.
 *   DAILY_TAGS       — comma-separated default tags (default: "daily,journal").
 *   DAILY_OPEN       — set to "1" to open the file in $EDITOR after writing.
 *
 * Usage:
 *   node scripts/ingest-daily-note.mjs
 *   DAILY_DATE=2025-01-01 node scripts/ingest-daily-note.mjs
 *   DAILY_NOTES_DIR=~/Obsidian/Daily DAILY_OPEN=1 node scripts/ingest-daily-note.mjs
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { GraphBuilder, loadGraph, saveGraph, stableId } from './lib/graph-store.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const GRAPH_PATH = join(REPO_ROOT, 'data', 'graph.json');
const SOURCE_ID = 'markdown';

const DEFAULT_CANDIDATE_DIRS = [
  join(homedir(), 'Documents', 'notes', 'daily'),
  join(homedir(), 'notes', 'daily'),
  join(homedir(), 'Obsidian', 'daily'),
  join(homedir(), 'Documents', 'daily'),
];

const DEFAULT_TAGS = (process.env.DAILY_TAGS || 'daily,journal')
  .split(',')
  .map((t) => t.trim().toLowerCase())
  .filter(Boolean);

function parseDate(raw) {
  // Accepts YYYY-MM-DD; falls back to today
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw || '');
  if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  return new Date();
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function previousDay(date) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() - 1);
  return d;
}

function nextDay(date) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

function longDate(date) {
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function buildTemplate(date) {
  const dateStr = formatDate(date);
  const prevStr = formatDate(previousDay(date));
  const nextStr = formatDate(nextDay(date));
  const tagsYaml = DEFAULT_TAGS.map((t) => `  - ${t}`).join('\n');

  return `---
title: "${longDate(date)}"
date: ${dateStr}
tags:
${tagsYaml}
---

# ${longDate(date)}

[[${prevStr}]] ← today → [[${nextStr}]]

---

## 📅 Meetings & Events

- 

---

## 💡 Ideas

- 

---

## 📓 Journal

> Write freely here…

---

## ✅ Tasks

- [ ] 

---

## 🔗 Links & References

- 
`;
}

async function resolveNotesDir() {
  if (process.env.DAILY_NOTES_DIR) {
    return resolve(process.env.DAILY_NOTES_DIR.trim());
  }
  for (const dir of DEFAULT_CANDIDATE_DIRS) {
    try {
      const s = await stat(dir);
      if (s.isDirectory()) return dir;
    } catch { /* not found */ }
  }
  // Create the first candidate
  const dir = DEFAULT_CANDIDATE_DIRS[0];
  await mkdir(dir, { recursive: true });
  return dir;
}

async function ingestNoteFile(filePath, date) {
  let text;
  try {
    text = await readFile(filePath, 'utf8');
  } catch {
    return;
  }

  const { frontmatter, body } = splitFrontmatter(text);
  const fm = parseFrontmatter(frontmatter);
  const title = fm.title ? String(fm.title).replace(/^"|"$/g, '') : formatDate(date);

  const tags = new Set(normaliseTags(fm.tags));
  for (const m of body.matchAll(/#([\w/-]+)/g)) {
    tags.add(m[1].toLowerCase());
  }

  const wikilinks = [];
  for (const m of body.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
    wikilinks.push(m[1].trim());
  }

  const existing = await loadGraph(GRAPH_PATH);
  const builder = new GraphBuilder(existing);

  const noteId = stableId('note', filePath);

  builder.upsertNode({
    id: noteId,
    label: title,
    type: 'note',
    sourceId: SOURCE_ID,
    createdAt: date.toISOString(),
    metadata: {
      path: filePath,
      wordCount: body.split(/\s+/).filter(Boolean).length,
      tags: [...tags],
      daily: true,
    },
  });

  for (const tag of tags) {
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
      relation: 'TAGGED_WITH',
      weight: 0.5,
    });
  }

  // Wire wikilinks to sibling daily notes already in the graph
  for (const link of wikilinks) {
    const targetId = stableId('note', join(resolve(filePath, '..'), `${link}.md`));
    const exists = builder.graph.nodes.find((n) => n.id === targetId);
    if (exists && exists.id !== noteId) {
      builder.upsertEdge({
        source: noteId,
        target: targetId,
        relation: 'LINKS_TO',
        weight: 0.6,
      });
    }
  }

  builder.recordSource(SOURCE_ID, { notes: 1 });
  await saveGraph(GRAPH_PATH, builder.graph);
  return builder.graph;
}

function splitFrontmatter(text) {
  if (!text.startsWith('---')) return { frontmatter: '', body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { frontmatter: '', body: text };
  return { frontmatter: text.slice(3, end).trim(), body: text.slice(end + 4) };
}

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

async function main() {
  const date = parseDate(process.env.DAILY_DATE);
  const dateStr = formatDate(date);
  const notesDir = await resolveNotesDir();
  const filePath = join(notesDir, `${dateStr}.md`);

  let existed = false;
  try {
    await stat(filePath);
    existed = true;
  } catch { /* does not exist */ }

  if (!existed) {
    const content = buildTemplate(date);
    await writeFile(filePath, content, 'utf8');
    console.log(`Created daily note: ${filePath}`);
  } else {
    console.log(`Daily note already exists: ${filePath}`);
  }

  const graph = await ingestNoteFile(filePath, date);
  if (graph) {
    console.log(`Graph: ${graph.nodes.length} nodes · ${graph.edges.length} edges`);
    console.log(`Wrote ${GRAPH_PATH}`);
  }

  if (process.env.DAILY_OPEN === '1') {
    const editor = process.env.EDITOR || process.env.VISUAL || 'open';
    execFile(editor, [filePath], (err) => {
      if (err) console.warn(`Could not open editor: ${err.message}`);
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
