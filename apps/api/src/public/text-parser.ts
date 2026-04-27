// Pure parsers for the public, anonymous ingest flow. No I/O, no DI — just
// turn pasted text or markdown into a (KGNode, KGEdge[]) bundle that the
// public ingest service can hand to GraphRepository + SensoryService.
//
// Phase 0 keeps this deliberately simple:
//   - text  → split on paragraphs; each non-trivial paragraph becomes a
//             `note` node; #hashtags become `concept` nodes with TAGGED_WITH
//             edges; bare URLs become `bookmark` nodes with REFERENCES edges.
//   - md    → same as text but additionally parses `[[wikilinks]]` (note→note
//             LINKS_TO) and headings (`# H1` becomes the document label).
//
// More elaborate pipelines (NLP entity extraction, embeddings, etc.) belong
// in the connector layer that lands in Phases 4+.

import { createHash } from 'node:crypto';
import type { KGEdge, KGNode, ConnectorId, EdgeRelation, NodeType } from '@pkg/shared';

const PARAGRAPH_MIN_LENGTH = 12;
const PARAGRAPH_MAX_LABEL = 120;
const MAX_NODES_PER_BATCH = 200;

export interface ParseOptions {
  userId: string;
  /** ConnectorId stamped on every produced node so downstream filters work. */
  sourceId: ConnectorId;
  /** Human-readable origin label — becomes the parent document node. */
  title: string;
  /** Override created/updated timestamps (test determinism). */
  now?: () => string;
}

export interface ParseResult {
  nodes: KGNode[];
  edges: KGEdge[];
  parentId: string;
}

/** Parse a plain-text blob into a graph fragment. */
export function parseText(text: string, options: ParseOptions): ParseResult {
  const ctx = makeContext(options);
  const parent = upsertNode(ctx, {
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
    const note = upsertNode(ctx, {
      label: noteLabel,
      type: 'note',
      metadata: { excerpt: noteLabel, length: paragraph.length },
    });
    upsertEdge(ctx, { source: parent.id, target: note.id, relation: 'PART_OF', weight: 0.6 });
    extractTags(paragraph, ctx, note);
    extractUrls(paragraph, ctx, note);
  }

  return finish(ctx);
}

/** Parse a markdown blob — supports headings, wikilinks, hashtags, and URLs. */
export function parseMarkdown(text: string, options: ParseOptions): ParseResult {
  const ctx = makeContext(options);
  const heading = extractFirstHeading(text);
  const parent = upsertNode(ctx, {
    label: heading || options.title,
    type: 'document',
    metadata: { format: 'markdown', length: text.length },
  });

  const sections = splitMarkdownSections(text).slice(0, MAX_NODES_PER_BATCH);
  for (const section of sections) {
    const noteLabel = truncate(section.title || section.body.slice(0, 80) || '(empty)', PARAGRAPH_MAX_LABEL);
    if (!noteLabel.trim()) continue;
    const note = upsertNode(ctx, {
      label: noteLabel,
      type: 'note',
      metadata: { heading: section.title, level: section.level, length: section.body.length },
    });
    upsertEdge(ctx, { source: parent.id, target: note.id, relation: 'PART_OF', weight: 0.6 });
    extractTags(section.body, ctx, note);
    extractUrls(section.body, ctx, note);
    extractWikilinks(section.body, ctx, note);
  }

  return finish(ctx);
}

// ── internals ─────────────────────────────────────────────────────────

interface ParseContext {
  options: ParseOptions;
  now: string;
  nodes: Map<string, KGNode>;
  edges: Map<string, KGEdge>;
  parentId?: string;
}

function makeContext(options: ParseOptions): ParseContext {
  const now = options.now?.() ?? new Date().toISOString();
  return { options, now, nodes: new Map(), edges: new Map() };
}

function finish(ctx: ParseContext): ParseResult {
  const parentId = ctx.parentId ?? '';
  return {
    parentId,
    nodes: [...ctx.nodes.values()],
    edges: [...ctx.edges.values()],
  };
}

function upsertNode(
  ctx: ParseContext,
  spec: { label: string; type: NodeType; metadata?: Record<string, unknown> },
): KGNode {
  const { sourceId, userId } = ctx.options;
  const id = stableUuid(userId, spec.type, spec.label);
  const existing = ctx.nodes.get(id);
  if (existing) return existing;
  const node: KGNode = {
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

function upsertEdge(
  ctx: ParseContext,
  spec: { source: string; target: string; relation: EdgeRelation; weight?: number },
): KGEdge | null {
  if (spec.source === spec.target) return null;
  const id = stableEdgeUuid(ctx.options.userId, spec.relation, spec.source, spec.target);
  const existing = ctx.edges.get(id);
  if (existing) {
    existing.weight = clampUnit((existing.weight + (spec.weight ?? 0.4)) / 2);
    return existing;
  }
  const edge: KGEdge = {
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

function extractTags(text: string, ctx: ParseContext, parent: KGNode): void {
  const seen = new Set<string>();
  for (const match of text.matchAll(/(?:^|\s)#([A-Za-z][\w-]{1,40})/g)) {
    const tag = match[1]?.toLowerCase();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    const tagNode = upsertNode(ctx, { label: `#${tag}`, type: 'concept', metadata: { tag } });
    upsertEdge(ctx, { source: parent.id, target: tagNode.id, relation: 'TAGGED_WITH', weight: 0.5 });
  }
}

function extractUrls(text: string, ctx: ParseContext, parent: KGNode): void {
  const seen = new Set<string>();
  for (const match of text.matchAll(/https?:\/\/[^\s)>\]]+/g)) {
    const url = match[0];
    if (seen.has(url)) continue;
    seen.add(url);
    const label = safeUrlLabel(url);
    const node = upsertNode(ctx, {
      label,
      type: 'bookmark',
      metadata: { url },
    });
    node.sourceUrl = url;
    upsertEdge(ctx, { source: parent.id, target: node.id, relation: 'REFERENCES', weight: 0.4 });
  }
}

function extractWikilinks(text: string, ctx: ParseContext, parent: KGNode): void {
  const seen = new Set<string>();
  for (const match of text.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
    const target = match[1]?.trim();
    if (!target || seen.has(target)) continue;
    seen.add(target);
    const node = upsertNode(ctx, { label: target, type: 'note', metadata: { wikilink: true } });
    upsertEdge(ctx, { source: parent.id, target: node.id, relation: 'LINKS_TO', weight: 0.55 });
  }
}

function extractFirstHeading(md: string): string | null {
  const m = md.match(/^\s*#\s+(.+?)\s*$/m);
  return m?.[1]?.trim() || null;
}

interface MdSection {
  level: number;
  title: string;
  body: string;
}

function splitMarkdownSections(md: string): MdSection[] {
  const lines = md.split(/\r?\n/);
  const sections: MdSection[] = [];
  let current: MdSection = { level: 0, title: '', body: '' };
  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (m) {
      if (current.title || current.body.trim()) sections.push(current);
      current = { level: m[1]!.length, title: m[2]!.trim(), body: '' };
    } else {
      current.body += line + '\n';
    }
  }
  if (current.title || current.body.trim()) sections.push(current);
  return sections;
}

function safeUrlLabel(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname === '/' ? '' : u.pathname}`.slice(0, PARAGRAPH_MAX_LABEL);
  } catch {
    return url.slice(0, PARAGRAPH_MAX_LABEL);
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function clampUnit(x: number): number {
  if (Number.isNaN(x)) return 0.4;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/** SHA-256-derived UUID (v4-shaped) keyed on userId + a stable label triple,
 *  so re-pasting the same text upserts the same nodes. Mirrors the layout that
 *  `connector-utils.deterministicUuid` produces; centralised here so the
 *  public path doesn't depend on the connector module. */
export function stableUuid(...parts: string[]): string {
  const h = createHash('sha256').update(parts.join('')).digest('hex');
  const variantNibble = '89ab'[parseInt(h.charAt(16), 16) & 3] ?? '8';
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `4${h.slice(13, 16)}`,
    `${variantNibble}${h.slice(17, 20)}`,
    h.slice(20, 32),
  ].join('-');
}

function stableEdgeUuid(userId: string, relation: string, source: string, target: string): string {
  return stableUuid(userId, 'edge', relation, source, target);
}
