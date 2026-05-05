// Per-extension parsers used by the batch folder upload pipeline.
//
// Each exported function takes `(text, ctx)` where:
//   text — the file contents already decoded as a UTF-8 string
//   ctx  — { relativePath, sourceId, fileNodeId, now }
// and returns `{ nodes: KGNode[], edges: KGEdge[] }`. The caller is expected
// to have already created `ctx.fileNodeId` (the file node) and to wire the
// returned children to it via `EXTRACTED_FROM` edges — these helpers do that
// themselves to keep the call site small.
//
// All emissions are bounded (heading caps, paragraph caps, etc.) so a single
// pathological file can't blow past the server-side 5 000-node / 20 000-edge
// per-request limits documented in src/worker.js.

import { makeEdge, makeNode, truncate, basename } from './util.js';

const PARAGRAPH_MIN_LENGTH = 12;
const PARAGRAPH_MAX_LABEL = 120;
const MAX_PARAGRAPHS_PER_FILE = 80;
const MAX_HEADINGS_PER_FILE = 60;
const MAX_TAGS_PER_FILE = 40;
const MAX_LINKS_PER_FILE = 40;
const MAX_JSON_KEYS = 40;
const MAX_CSV_FIELDS = 40;
const MAX_CSV_ROWS_SAMPLED = 200;
const MAX_IMPORTS_PER_FILE = 80;

// ── markdown ───────────────────────────────────────────────────────────

export async function parseMarkdownFile(text, ctx) {
  const nodes = [];
  const edges = [];
  const sections = splitMarkdownSections(text).slice(0, MAX_HEADINGS_PER_FILE);

  for (const section of sections) {
    const label = truncate(
      section.title || section.body.slice(0, 80) || '(empty)',
      PARAGRAPH_MAX_LABEL,
    );
    if (!label.trim()) continue;
    const node = await makeNode(ctx, {
      idParts: ['heading', ctx.relativePath, section.title || `pos:${section.pos}`],
      label,
      type: 'note',
      metadata: { heading: section.title, level: section.level, length: section.body.length },
    });
    nodes.push(node);
    const e = await makeEdge(ctx, {
      source: ctx.fileNodeId,
      target: node.id,
      relation: 'EXTRACTED_FROM',
      weight: 0.6,
    });
    if (e) edges.push(e);
    await extractTagsAndLinks(section.body, ctx, node, nodes, edges);
  }
  return { nodes, edges };
}

// ── plain text ─────────────────────────────────────────────────────────

export async function parseTextFile(text, ctx) {
  const nodes = [];
  const edges = [];
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length >= PARAGRAPH_MIN_LENGTH)
    .slice(0, MAX_PARAGRAPHS_PER_FILE);

  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i];
    const label = truncate(para.replace(/\s+/g, ' '), PARAGRAPH_MAX_LABEL);
    const node = await makeNode(ctx, {
      idParts: ['paragraph', ctx.relativePath, String(i)],
      label,
      type: 'note',
      metadata: { excerpt: label, length: para.length },
    });
    nodes.push(node);
    const e = await makeEdge(ctx, {
      source: ctx.fileNodeId,
      target: node.id,
      relation: 'EXTRACTED_FROM',
      weight: 0.55,
    });
    if (e) edges.push(e);
    await extractTagsAndLinks(para, ctx, node, nodes, edges);
  }
  return { nodes, edges };
}

// ── HTML ───────────────────────────────────────────────────────────────

// HTML entities decoded as a single-pass map so a doubly-escaped string like
// `&amp;lt;` renders as `&lt;` (literal entity), not `<` (the unsafe
// double-unescape pattern flagged by `js/double-escaping`).
const HTML_ENTITY_MAP = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};
const HTML_ENTITY_RE = /&(?:nbsp|amp|lt|gt|quot|#39);/gi;

// Tag-stripping helpers tolerate optional trailing whitespace before `>`
// (e.g. `</script >`) — matches what real browsers accept and avoids the
// `js/bad-tag-filter` class of bypasses.
const STRIPPED_BLOCK_TAGS_RE = /<(script|style|nav|footer|header|svg)\b[\s\S]*?<\/\1\s*>/gi;
const ANY_TAG_RE = /<\/?[A-Za-z][\s\S]*?>/g;

export async function parseHtmlFile(text, ctx) {
  const cleaned = text
    .replace(STRIPPED_BLOCK_TAGS_RE, ' ')
    .replace(ANY_TAG_RE, ' ')
    .replace(HTML_ENTITY_RE, (m) => HTML_ENTITY_MAP[m.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
  return parseTextFile(cleaned, ctx);
}

// ── JSON ───────────────────────────────────────────────────────────────

export async function parseJsonFile(text, ctx) {
  const nodes = [];
  const edges = [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { nodes, edges }; // unparseable JSON → just keep the file node
  }
  if (parsed == null || typeof parsed !== 'object') return { nodes, edges };

  const entries = Array.isArray(parsed)
    ? parsed.slice(0, MAX_JSON_KEYS).map((v, i) => [`[${i}]`, v])
    : Object.entries(parsed).slice(0, MAX_JSON_KEYS);

  for (const [key, value] of entries) {
    const sample = stringifyShort(value);
    const node = await makeNode(ctx, {
      idParts: ['json-key', ctx.relativePath, key],
      label: truncate(`${key}`, PARAGRAPH_MAX_LABEL),
      type: 'concept',
      metadata: {
        key: String(key).slice(0, 200),
        valueType: Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value,
        sample,
      },
    });
    nodes.push(node);
    const e = await makeEdge(ctx, {
      source: ctx.fileNodeId,
      target: node.id,
      relation: 'EXTRACTED_FROM',
      weight: 0.5,
    });
    if (e) edges.push(e);
  }
  return { nodes, edges };
}

// ── CSV / TSV ──────────────────────────────────────────────────────────

export async function parseCsvFile(text, ctx, delimiter = ',') {
  const nodes = [];
  const edges = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { nodes, edges };
  const header = splitCsvLine(lines[0], delimiter).slice(0, MAX_CSV_FIELDS);
  const rowCount = Math.max(0, lines.length - 1);
  for (let i = 0; i < header.length; i++) {
    const field = header[i].trim();
    if (!field) continue;
    const node = await makeNode(ctx, {
      idParts: ['csv-field', ctx.relativePath, String(i), field],
      label: truncate(field, PARAGRAPH_MAX_LABEL),
      type: 'concept',
      metadata: { csvField: field, columnIndex: i, rowCount },
    });
    nodes.push(node);
    const e = await makeEdge(ctx, {
      source: ctx.fileNodeId,
      target: node.id,
      relation: 'EXTRACTED_FROM',
      weight: 0.5,
      metadata: { rowCount: Math.min(rowCount, MAX_CSV_ROWS_SAMPLED) },
    });
    if (e) edges.push(e);
  }
  return { nodes, edges };
}

export async function parseTsvFile(text, ctx) {
  return parseCsvFile(text, ctx, '\t');
}

// ── source code (regex-based, no AST) ──────────────────────────────────

const IMPORT_PATTERNS = {
  js: [
    /\bimport\s+(?:[\s\S]*?)from\s+['"]([^'"]+)['"]/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ],
  py: [/^\s*from\s+([\w.]+)\s+import\b/gm, /^\s*import\s+([\w.,\s]+)$/gm],
  go: [/^\s*import\s+(?:\(\s*([\s\S]*?)\)|"([^"]+)")/gm],
  java: [/^\s*import\s+(?:static\s+)?([\w.*]+)\s*;/gm],
  rb: [/^\s*require(?:_relative)?\s+['"]([^'"]+)['"]/gm],
  rs: [/^\s*use\s+([\w:]+)/gm],
  cs: [/^\s*using\s+([\w.]+)\s*;/gm],
  c: [/^\s*#include\s+[<"]([^>"]+)[>"]/gm],
  sh: [/^\s*(?:source|\.)\s+([^\s]+)/gm],
};

const EXT_TO_LANG = {
  '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'js',
  '.ts': 'js', '.tsx': 'js',
  '.py': 'py',
  '.go': 'go',
  '.java': 'java',
  '.rb': 'rb',
  '.rs': 'rs',
  '.cs': 'cs',
  '.c': 'c', '.h': 'c', '.cpp': 'c', '.cc': 'c', '.hpp': 'c', '.hh': 'c',
  '.sh': 'sh', '.bash': 'sh', '.zsh': 'sh',
};

/**
 * Source-code parser. Extracts imports/requires via cheap regex (no AST) and
 * surfaces them as `REFERENCES` edges from this file to a synthetic module
 * node. The caller (registry/index.js) turns intra-folder references into
 * cross-file `REFERENCES` edges by resolving the module path; that's done
 * after all files have been parsed so we have the full file-id map.
 *
 * Returns `imports: string[]` so the registry can post-process file→file
 * links once every file node id is known.
 */
export async function parseSourceFile(text, ctx, ext) {
  const nodes = [];
  const edges = [];
  const lang = EXT_TO_LANG[ext];
  const imports = new Set();

  if (lang && IMPORT_PATTERNS[lang]) {
    for (const re of IMPORT_PATTERNS[lang]) {
      // Use matchAll (stateless) instead of repeated re.exec() — the latter
      // keeps `lastIndex` on the shared global regex and would leak state
      // across files. Bonus: matchAll is more idiomatic in modern browsers.
      for (const m of text.matchAll(re)) {
        const raw = (m[1] || m[2] || '').trim();
        if (!raw) continue;
        // Python `import a, b` — split into individual modules
        for (const piece of raw.split(/[,\n]/)) {
          const cleaned = piece.trim().replace(/\s+as\s+\w+$/, '');
          if (cleaned) imports.add(cleaned);
          if (imports.size >= MAX_IMPORTS_PER_FILE) break;
        }
        if (imports.size >= MAX_IMPORTS_PER_FILE) break;
      }
      if (imports.size >= MAX_IMPORTS_PER_FILE) break;
    }
  }

  for (const mod of imports) {
    const node = await makeNode(ctx, {
      idParts: ['module', mod],
      label: truncate(mod, PARAGRAPH_MAX_LABEL),
      type: 'module',
      metadata: { module: mod, lang: lang || 'unknown' },
    });
    nodes.push(node);
    const e = await makeEdge(ctx, {
      source: ctx.fileNodeId,
      target: node.id,
      relation: 'IMPORTS',
      weight: 0.6,
      metadata: { module: mod },
    });
    if (e) edges.push(e);
  }

  return { nodes, edges, imports: [...imports] };
}

// ── helpers ────────────────────────────────────────────────────────────

function splitMarkdownSections(md) {
  const lines = md.split(/\r?\n/);
  const sections = [];
  let current = { level: 0, title: '', body: '', pos: 0 };
  let pos = 0;
  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (m) {
      if (current.title || current.body.trim()) sections.push(current);
      current = { level: m[1].length, title: m[2].trim(), body: '', pos };
    } else {
      current.body += `${line}\n`;
    }
    pos += 1;
  }
  if (current.title || current.body.trim()) sections.push(current);
  return sections;
}

async function extractTagsAndLinks(text, ctx, parent, nodes, edges) {
  const tagSeen = new Set();
  let tagCount = 0;
  for (const match of text.matchAll(/(?:^|\s)#([A-Za-z][\w-]{1,40})/g)) {
    if (tagCount >= MAX_TAGS_PER_FILE) break;
    const tag = (match[1] || '').toLowerCase();
    if (!tag || tagSeen.has(tag)) continue;
    tagSeen.add(tag);
    tagCount += 1;
    const tagNode = await makeNode(ctx, {
      idParts: ['tag', tag],
      label: `#${tag}`,
      type: 'concept',
      metadata: { tag },
    });
    nodes.push(tagNode);
    const e = await makeEdge(ctx, {
      source: parent.id,
      target: tagNode.id,
      relation: 'TAGGED_WITH',
      weight: 0.45,
    });
    if (e) edges.push(e);
  }

  const linkSeen = new Set();
  let linkCount = 0;
  for (const match of text.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
    if (linkCount >= MAX_LINKS_PER_FILE) break;
    const target = (match[1] || '').trim();
    if (!target || linkSeen.has(target)) continue;
    linkSeen.add(target);
    linkCount += 1;
    const linkNode = await makeNode(ctx, {
      idParts: ['wikilink', target],
      label: truncate(target, PARAGRAPH_MAX_LABEL),
      type: 'note',
      metadata: { wikilink: true },
    });
    nodes.push(linkNode);
    const e = await makeEdge(ctx, {
      source: parent.id,
      target: linkNode.id,
      relation: 'LINKS_TO',
      weight: 0.5,
    });
    if (e) edges.push(e);
  }

  const urlSeen = new Set();
  for (const match of text.matchAll(/https?:\/\/[^\s)>\]]+/g)) {
    if (urlSeen.size >= MAX_LINKS_PER_FILE) break;
    const url = match[0];
    if (urlSeen.has(url)) continue;
    urlSeen.add(url);
    const label = safeUrlLabel(url);
    const node = await makeNode(ctx, {
      idParts: ['url', url],
      label,
      type: 'bookmark',
      metadata: { url },
      sourceUrl: url,
    });
    nodes.push(node);
    const e = await makeEdge(ctx, {
      source: parent.id,
      target: node.id,
      relation: 'REFERENCES',
      weight: 0.4,
    });
    if (e) edges.push(e);
  }
}

function safeUrlLabel(url) {
  try {
    const u = new URL(url);
    return truncate(`${u.hostname}${u.pathname === '/' ? '' : u.pathname}`, PARAGRAPH_MAX_LABEL);
  } catch {
    return truncate(url, PARAGRAPH_MAX_LABEL);
  }
}

function splitCsvLine(line, delimiter) {
  // RFC-4180-ish: handles quoted fields with embedded delimiters and "" escapes.
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function stringifyShort(value) {
  try {
    const s = typeof value === 'string' ? value : JSON.stringify(value);
    return truncate(s ?? '', 200);
  } catch {
    return '';
  }
}

// Re-export for ergonomic imports from index.js
export { basename };
