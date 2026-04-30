// Worker-compatible port of apps/api/src/public/text-parser.ts. Uses the Web
// Crypto API (available in Cloudflare Workers and modern Node) instead of
// `node:crypto` so this module can run inside the edge runtime without a
// build step.
//
// Pure functions only — no I/O. The Worker entrypoint is responsible for
// persisting the produced KGNode/KGEdge bundle.

const PARAGRAPH_MIN_LENGTH = 12;
const PARAGRAPH_MAX_LABEL = 120;
const MAX_NODES_PER_BATCH = 200;

/** Parse a plain-text blob into a graph fragment. */
export async function parseText(text, options) {
  const ctx = await makeContext(options);
  const parent = await upsertNode(ctx, {
    label: options.title,
    type: 'document',
    metadata: { format: 'text', length: text.length },
  });

  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length >= PARAGRAPH_MIN_LENGTH)
    .slice(0, MAX_NODES_PER_BATCH);

  for (const paragraph of paragraphs) {
    const noteLabel = truncate(paragraph.replace(/\s+/g, ' '), PARAGRAPH_MAX_LABEL);
    const note = await upsertNode(ctx, {
      label: noteLabel,
      type: 'note',
      metadata: { excerpt: noteLabel, length: paragraph.length },
    });
    await upsertEdge(ctx, { source: parent.id, target: note.id, relation: 'PART_OF', weight: 0.6 });
    await extractTags(paragraph, ctx, note);
    await extractUrls(paragraph, ctx, note);
  }

  return finish(ctx);
}

/** Parse a markdown blob — supports headings, wikilinks, hashtags, and URLs. */
export async function parseMarkdown(text, options) {
  const ctx = await makeContext(options);
  const heading = extractFirstHeading(text);
  const parent = await upsertNode(ctx, {
    label: heading || options.title,
    type: 'document',
    metadata: { format: 'markdown', length: text.length },
  });

  const sections = splitMarkdownSections(text).slice(0, MAX_NODES_PER_BATCH);
  for (const section of sections) {
    const noteLabel = truncate(section.title || section.body.slice(0, 80) || '(empty)', PARAGRAPH_MAX_LABEL);
    if (!noteLabel.trim()) continue;
    const note = await upsertNode(ctx, {
      label: noteLabel,
      type: 'note',
      metadata: { heading: section.title, level: section.level, length: section.body.length },
    });
    await upsertEdge(ctx, { source: parent.id, target: note.id, relation: 'PART_OF', weight: 0.6 });
    await extractTags(section.body, ctx, note);
    await extractUrls(section.body, ctx, note);
    await extractWikilinks(section.body, ctx, note);
  }

  return finish(ctx);
}

// ── internals ─────────────────────────────────────────────────────────

async function makeContext(options) {
  const now = options.now?.() ?? new Date().toISOString();
  return { options, now, nodes: new Map(), edges: new Map(), parentId: undefined };
}

function finish(ctx) {
  return {
    parentId: ctx.parentId ?? '',
    nodes: [...ctx.nodes.values()],
    edges: [...ctx.edges.values()],
  };
}

async function upsertNode(ctx, spec) {
  const { sourceId, userId } = ctx.options;
  const id = await stableUuid(userId, spec.type, spec.label);
  const existing = ctx.nodes.get(id);
  if (existing) return existing;
  const node = {
    id,
    label: spec.label,
    type: spec.type,
    sourceId,
    metadata: spec.metadata ?? {},
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  ctx.nodes.set(id, node);
  if (spec.type === 'document' && !ctx.parentId) ctx.parentId = id;
  return node;
}

async function upsertEdge(ctx, spec) {
  if (spec.source === spec.target) return null;
  const id = await stableEdgeUuid(ctx.options.userId, spec.relation, spec.source, spec.target);
  const existing = ctx.edges.get(id);
  if (existing) {
    existing.weight = clampUnit((existing.weight + (spec.weight ?? 0.4)) / 2);
    return existing;
  }
  const edge = {
    id,
    source: spec.source,
    target: spec.target,
    relation: spec.relation,
    weight: clampUnit(spec.weight ?? 0.4),
    inferred: true,
    createdAt: ctx.now,
    metadata: {},
  };
  ctx.edges.set(id, edge);
  return edge;
}

async function extractTags(text, ctx, parent) {
  const seen = new Set();
  for (const match of text.matchAll(/(?:^|\s)#([A-Za-z][\w-]{1,40})/g)) {
    const tag = match[1]?.toLowerCase();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    const tagNode = await upsertNode(ctx, { label: `#${tag}`, type: 'concept', metadata: { tag } });
    await upsertEdge(ctx, { source: parent.id, target: tagNode.id, relation: 'TAGGED_WITH', weight: 0.5 });
  }
}

async function extractUrls(text, ctx, parent) {
  const seen = new Set();
  for (const match of text.matchAll(/https?:\/\/[^\s)>\]]+/g)) {
    const url = match[0];
    if (seen.has(url)) continue;
    seen.add(url);
    const label = safeUrlLabel(url);
    const node = await upsertNode(ctx, {
      label,
      type: 'bookmark',
      metadata: { url },
    });
    node.sourceUrl = url;
    await upsertEdge(ctx, { source: parent.id, target: node.id, relation: 'REFERENCES', weight: 0.4 });
  }
}

async function extractWikilinks(text, ctx, parent) {
  const seen = new Set();
  for (const match of text.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
    const target = match[1]?.trim();
    if (!target || seen.has(target)) continue;
    seen.add(target);
    const node = await upsertNode(ctx, { label: target, type: 'note', metadata: { wikilink: true } });
    await upsertEdge(ctx, { source: parent.id, target: node.id, relation: 'LINKS_TO', weight: 0.55 });
  }
}

function extractFirstHeading(md) {
  const m = md.match(/^\s*#\s+(.+?)\s*$/m);
  return m?.[1]?.trim() || null;
}

function splitMarkdownSections(md) {
  const lines = md.split(/\r?\n/);
  const sections = [];
  let current = { level: 0, title: '', body: '' };
  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (m) {
      if (current.title || current.body.trim()) sections.push(current);
      current = { level: m[1].length, title: m[2].trim(), body: '' };
    } else {
      current.body += line + '\n';
    }
  }
  if (current.title || current.body.trim()) sections.push(current);
  return sections;
}

function safeUrlLabel(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname === '/' ? '' : u.pathname}`.slice(0, PARAGRAPH_MAX_LABEL);
  } catch {
    return url.slice(0, PARAGRAPH_MAX_LABEL);
  }
}

function truncate(s, n) {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function clampUnit(x) {
  if (Number.isNaN(x)) return 0.4;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/** SHA-256-derived UUID (v4-shaped) keyed on a stable label tuple, so
 *  re-pasting the same text upserts the same nodes. Mirrors the layout that
 *  apps/api/src/public/text-parser.ts produces, but uses Web Crypto. */
export async function stableUuid(...parts) {
  const data = new TextEncoder().encode(parts.join(''));
  const buf = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(buf);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  const variantNibble = '89ab'[parseInt(hex.charAt(16), 16) & 3] ?? '8';
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${variantNibble}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

async function stableEdgeUuid(userId, relation, source, target) {
  return stableUuid(userId, 'edge', relation, source, target);
}
