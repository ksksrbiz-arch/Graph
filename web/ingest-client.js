/**
 * Client-side graph ingesters.
 *
 * These run entirely in the browser when the local dev server is unavailable.
 * Each exported function parses a data source and returns { nodes, edges }
 * ready to be sent to POST /api/v1/public/ingest/graph via ingestPublicGraph().
 *
 * ID generation uses FNV-1a (deterministic, pure JS) rather than Node.js
 * crypto SHA-1. IDs are stable across re-runs of the same data, ensuring
 * idempotent merges within the KV-backed public graph.
 *
 * Supported connectors:
 *   parseBookmarks(html)                       — Netscape HTML bookmark export
 *   parseEnex(xml)                             — Evernote ENEX export
 *   parseClaudeExport(json)                    — Claude.ai conversations.json
 *   parseMarkdownFiles(files)                  — Obsidian / plain .md folder upload
 *   buildDailyNote({ date, tags })             — Generates today's daily note
 *   clipUrls(urls)                             — Web-clip a list of URLs (CORS permitting)
 *   parseClaudeCodeSessions(files)             — ~/.claude/projects JSONL session files
 *   ingestZotero({ userId, apiKey, ... })      — Zotero Web API (fetch from browser)
 *   ingestGithub({ token, login, ... })        — GitHub REST API (fetch from browser)
 */

// ── Deterministic ID generation (FNV-1a 32-bit, two-pass → 16 hex chars) ────

function fnv32a(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function stableId(type, key) {
  const input = `${type}::${key}`;
  return `${type}_${fnv32a(input, 0x811c9dc5)}${fnv32a(input, 0x84222325)}`;
}

// ── Minimal GraphBuilder (mirrors scripts/lib/graph-store.mjs) ────────────────

class GraphBuilder {
  constructor() {
    this.nodes = [];
    this.edges = [];
    this._ni = new Map();
    this._ei = new Map();
  }

  upsertNode(node) {
    const id = node.id || stableId(node.type, node.label);
    const now = new Date().toISOString();
    const existing = this._ni.get(id);
    if (existing) {
      existing.label = node.label ?? existing.label;
      existing.metadata = { ...existing.metadata, ...(node.metadata || {}) };
      existing.updatedAt = now;
      if (node.createdAt && (!existing.createdAt || node.createdAt < existing.createdAt)) {
        existing.createdAt = node.createdAt;
      }
      return existing;
    }
    const created = {
      id,
      label: node.label || id,
      type: node.type,
      sourceId: node.sourceId || 'unknown',
      sourceUrl: node.sourceUrl,
      createdAt: node.createdAt || now,
      updatedAt: now,
      metadata: node.metadata || {},
    };
    this.nodes.push(created);
    this._ni.set(id, created);
    return created;
  }

  upsertEdge({ source, target, relation, weight = 0.5, metadata = {} }) {
    if (!source || !target || source === target) return null;
    const id = `${source}|${relation}|${target}`;
    const existing = this._ei.get(id);
    if (existing) {
      existing.weight = Math.min(1, existing.weight + weight * 0.25);
      existing.metadata = { ...existing.metadata, ...metadata };
      existing.metadata.count = (existing.metadata.count || 1) + 1;
      return existing;
    }
    const edge = {
      id,
      source,
      target,
      relation,
      weight: Math.max(0, Math.min(1, weight)),
      inferred: false,
      createdAt: new Date().toISOString(),
      metadata: { count: 1, ...metadata },
    };
    this.edges.push(edge);
    this._ei.set(id, edge);
    return edge;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function stripHtmlTags(text) {
  // Strip HTML tags first, then decode any remaining entities.
  // Stripping before decoding prevents entity-encoded tags (e.g. &lt;script&gt;)
  // from being reconstructed as real markup after entity decoding.
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
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
    .replace(/&amp;/g, '&');
}

export const BROWSER_INGEST_LIMITS = Object.freeze({
  maxFilesPerUpload: 200,
  maxSingleFileBytes: 5 * 1024 * 1024,
  maxTotalFileBytes: 25 * 1024 * 1024,
  maxRemoteBytes: 1_500_000,
  maxRemoteUrls: 25,
  fetchTimeoutMs: 8_000,
});

function isFileLike(value) {
  return Boolean(value)
    && typeof value.name === 'string'
    && typeof value.size === 'number'
    && typeof value.text === 'function';
}

function acceptedExtensions(field) {
  return String(field?.accept || '')
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.startsWith('.'));
}

function matchesAcceptedExtension(file, extensions) {
  if (!extensions.length) return true;
  const lower = file.name.toLowerCase();
  return extensions.some((ext) => lower.endsWith(ext));
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function validateSelectedFiles(field, inputFiles) {
  const files = Array.isArray(inputFiles)
    ? inputFiles
    : inputFiles
      ? [inputFiles]
      : [];
  const isMulti = field?.type === 'multifile';
  const exts = acceptedExtensions(field);

  if (field?.required && files.length === 0) {
    throw new Error(`${field.label || 'File'} is required`);
  }
  if (!isMulti && files.length > 1) {
    throw new Error(`${field.label || 'File'} accepts only one file`);
  }
  if (files.length > BROWSER_INGEST_LIMITS.maxFilesPerUpload) {
    throw new Error(
      `${field.label || 'File upload'} exceeds the ${BROWSER_INGEST_LIMITS.maxFilesPerUpload}-file limit`,
    );
  }

  let totalBytes = 0;
  for (const file of files) {
    if (!isFileLike(file)) {
      throw new Error(`Unsupported file input for ${field.label || 'upload'}`);
    }
    if (!matchesAcceptedExtension(file, exts)) {
      throw new Error(
        `${file.name} is not an accepted file type for ${field.label || 'this upload'}`,
      );
    }
    if (file.size > BROWSER_INGEST_LIMITS.maxSingleFileBytes) {
      throw new Error(
        `${file.name} is too large (${formatBytes(file.size)} > ${formatBytes(BROWSER_INGEST_LIMITS.maxSingleFileBytes)})`,
      );
    }
    totalBytes += file.size;
  }

  if (totalBytes > BROWSER_INGEST_LIMITS.maxTotalFileBytes) {
    throw new Error(
      `${field.label || 'Upload'} is too large (${formatBytes(totalBytes)} > ${formatBytes(BROWSER_INGEST_LIMITS.maxTotalFileBytes)})`,
    );
  }

  return files;
}

function clampPositiveInt(value, fallback, max) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.min(Math.trunc(num), max);
}

function requireNumericId(value, field) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error(`${field} is required`);
  if (!/^\d+$/.test(raw)) throw new Error(`${field} must be numeric`);
  return raw;
}

function isPrivateOrLocalHostname(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host === '::1' || host.endsWith('.localhost')) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const parts = host.split('.').map(Number);
    if (parts[0] === 10 || parts[0] === 127) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  }
  if (/^(?:fc|fd|fe80):/i.test(host)) return true;
  return false;
}

function normalizePublicHttpUrl(raw) {
  let parsed;
  try {
    parsed = new URL(String(raw || '').trim());
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Only http(s) URLs are allowed: ${raw}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`URLs with embedded credentials are not allowed: ${parsed.hostname}`);
  }
  if (isPrivateOrLocalHostname(parsed.hostname)) {
    throw new Error(`Local/private network URLs are not allowed in browser-only ingest: ${parsed.hostname}`);
  }
  parsed.hash = '';
  return parsed.toString();
}

async function fetchTextWithLimits(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BROWSER_INGEST_LIMITS.fetchTimeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const contentLength = Number(res.headers.get('content-length') || 0);
    if (contentLength > BROWSER_INGEST_LIMITS.maxRemoteBytes) {
      throw new Error(`response too large (${formatBytes(contentLength)})`);
    }
    const text = await res.text();
    if (text.length > BROWSER_INGEST_LIMITS.maxRemoteBytes) {
      throw new Error(`response too large (${formatBytes(text.length)})`);
    }
    return { res, text };
  } finally {
    clearTimeout(timeout);
  }
}

// ── Bookmarks parser ──────────────────────────────────────────────────────────

/**
 * Parse a Netscape HTML bookmarks export.
 * @param {string} html
 * @returns {{ nodes: object[], edges: object[], sourceId: string }}
 */
export function parseBookmarks(html) {
  const SOURCE_ID = 'bookmarks';
  const builder = new GraphBuilder();
  const currentFolder = [];

  for (const line of html.split('\n')) {
    const trimmed = line.trim();

    if (/<H3/i.test(trimmed)) {
      const m = /<H3[^>]*>([\s\S]*?)<\/H3>/i.exec(trimmed);
      currentFolder.push(m ? stripHtmlTags(m[1]) : 'Unknown');
    } else if (/<\/DL>/i.test(trimmed)) {
      currentFolder.pop();
    } else if (/<A\s+/i.test(trimmed)) {
      const aMatch = /<A\s+([^>]+)>([\s\S]*?)<\/A>/i.exec(trimmed);
      if (!aMatch) continue;

      const attrsStr = aMatch[1];
      const title = (stripHtmlTags(aMatch[2]).trim() || '(untitled)').slice(0, 200);
      const attrs = {};
      const attrRe = /(\w[\w-]*)=["']([^"']*)["']/gi;
      let m;
      while ((m = attrRe.exec(attrsStr)) !== null) attrs[m[1].toUpperCase()] = m[2];

      const url = attrs.HREF;
      if (!url || !url.startsWith('http')) continue;

      const addDateRaw = attrs.ADD_DATE;
      let addDate;
      if (addDateRaw) {
        const ts = Number(addDateRaw);
        if (!Number.isNaN(ts)) addDate = new Date(ts * 1000).toISOString();
      }

      const nodeId = stableId(SOURCE_ID, url);
      builder.upsertNode({
        id: nodeId,
        label: title,
        type: 'bookmark',
        sourceId: SOURCE_ID,
        sourceUrl: url,
        createdAt: addDate,
        metadata: { url, folder: currentFolder.join(' / ') || undefined },
      });

      if (currentFolder.length > 0) {
        const folderPath = currentFolder.join(' / ');
        const folderId = stableId('concept', `bookmark-folder:${folderPath}`);
        builder.upsertNode({
          id: folderId,
          label: currentFolder[currentFolder.length - 1],
          type: 'concept',
          sourceId: SOURCE_ID,
          metadata: { folderPath },
        });
        builder.upsertEdge({ source: nodeId, target: folderId, relation: 'PART_OF', weight: 0.5 });
      }
    }
  }

  return { nodes: builder.nodes, edges: builder.edges, sourceId: SOURCE_ID };
}

// ── Evernote ENEX parser ──────────────────────────────────────────────────────

function extractXmlText(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = re.exec(xml);
  return m ? decodeXmlEntities(m[1].trim()) : null;
}

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

function enmlToText(enml) {
  // Convert structural elements to whitespace, then strip all remaining tags.
  // ENML (Evernote Markup Language) is XHTML-based and should not contain
  // executable content, but we strip all tags regardless as a safety measure.
  return enml
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseEnexDate(raw) {
  if (!raw) return null;
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(raw);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
}

/**
 * Parse an Evernote ENEX export.
 * @param {string} xml
 * @returns {{ nodes: object[], edges: object[], sourceId: string }}
 */
export function parseEnex(xml) {
  const SOURCE_ID = 'evernote';
  const MAX_EXCERPT = 500;
  const builder = new GraphBuilder();

  const noteRe = /<note>([\s\S]*?)<\/note>/gi;
  let m;
  while ((m = noteRe.exec(xml)) !== null) {
    const block = m[1];
    const title = extractXmlText(block, 'title') || '(untitled)';
    const created = parseEnexDate(extractXmlText(block, 'created'));
    const notebook = extractXmlText(block, 'stack');
    const tags = extractXmlAll(block, 'tag');

    const contentMatch = /<content>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/content>/i.exec(block);
    const plainText = contentMatch ? enmlToText(contentMatch[1]) : '';

    const noteId = stableId(SOURCE_ID, `note:${title}:${created || ''}`);
    builder.upsertNode({
      id: noteId,
      label: title.slice(0, 200),
      type: 'note',
      sourceId: SOURCE_ID,
      createdAt: created || undefined,
      metadata: {
        excerpt: plainText.slice(0, MAX_EXCERPT),
        notebook,
        tags,
        wordCount: plainText.split(/\s+/).filter(Boolean).length,
      },
    });

    for (const tag of tags) {
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
      builder.upsertEdge({ source: noteId, target: tagId, relation: 'TAGGED_WITH', weight: 0.4 });
    }

    if (notebook) {
      const nbId = stableId('concept', `evernote-notebook:${notebook}`);
      builder.upsertNode({
        id: nbId,
        label: notebook,
        type: 'concept',
        sourceId: SOURCE_ID,
        metadata: { notebookName: notebook },
      });
      builder.upsertEdge({ source: noteId, target: nbId, relation: 'PART_OF', weight: 0.5 });
    }
  }

  return { nodes: builder.nodes, edges: builder.edges, sourceId: SOURCE_ID };
}

// ── Claude.ai export parser ───────────────────────────────────────────────────

function extractText(content) {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : '';
  return content
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n')
    .trim();
}

/**
 * Parse a Claude.ai conversations.json export.
 * @param {string|object} input  JSON string or already-parsed array/object.
 * @returns {{ nodes: object[], edges: object[], sourceId: string }}
 */
export function parseClaudeExport(input) {
  const SOURCE_ID = 'claude_export';
  const MAX_EXCERPT = 400;
  const builder = new GraphBuilder();

  let conversations;
  if (typeof input === 'string') {
    try { conversations = JSON.parse(input); } catch { return { nodes: [], edges: [], sourceId: SOURCE_ID }; }
  } else {
    conversations = input;
  }
  if (!Array.isArray(conversations)) conversations = [conversations];

  for (const conv of conversations) {
    if (!conv || typeof conv !== 'object') continue;
    const convId = conv.uuid || conv.id || stableId(SOURCE_ID, JSON.stringify(conv).slice(0, 80));
    const title = (conv.name || conv.title || '(Untitled conversation)').slice(0, 200);
    const createdAt = conv.created_at || conv.createdAt || undefined;

    const convNodeId = stableId(SOURCE_ID, `conv:${convId}`);
    builder.upsertNode({
      id: convNodeId,
      label: title,
      type: 'conversation',
      sourceId: SOURCE_ID,
      createdAt,
      metadata: {
        uuid: convId,
        messageCount: Array.isArray(conv.chat_messages) ? conv.chat_messages.length : 0,
      },
    });

    const messages = conv.chat_messages || conv.messages || [];
    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') continue;
      const role = msg.sender || msg.role || 'unknown';
      if (role !== 'human' && role !== 'user') continue;

      const text = extractText(msg.content || msg.text || '');
      if (!text) continue;

      const msgId = stableId(SOURCE_ID, `msg:${convId}:${msg.uuid || msg.id || text.slice(0, 40)}`);
      builder.upsertNode({
        id: msgId,
        label: text.slice(0, 80),
        type: 'note',
        sourceId: SOURCE_ID,
        createdAt: msg.created_at || msg.createdAt || createdAt,
        metadata: {
          excerpt: text.slice(0, MAX_EXCERPT),
          role,
          wordCount: text.split(/\s+/).filter(Boolean).length,
        },
      });
      builder.upsertEdge({ source: msgId, target: convNodeId, relation: 'PART_OF', weight: 0.6 });
    }
  }

  return { nodes: builder.nodes, edges: builder.edges, sourceId: SOURCE_ID };
}

// ── Zotero Web API ingester ───────────────────────────────────────────────────

/**
 * Fetch items from the Zotero Web API.
 * @param {{ userId: string, apiKey: string, groupId?: string, limit?: number }} opts
 * @returns {Promise<{ nodes: object[], edges: object[], sourceId: string }>}
 */
export async function ingestZotero({ userId, apiKey, groupId, limit = 200 }) {
  const SOURCE_ID = 'zotero';
  const BASE_URL = 'https://api.zotero.org';
  const API_VERSION = '3';
  const PAGE_SIZE = 50;

  const zoteroUserId = requireNumericId(userId, 'ZOTERO_USER_ID');
  const zoteroGroupId = groupId ? requireNumericId(groupId, 'ZOTERO_GROUP_ID') : undefined;
  const zoteroApiKey = String(apiKey || '').trim();
  const safeLimit = clampPositiveInt(limit, 200, 500);

  if (!zoteroApiKey) throw new Error('ZOTERO_API_KEY is required');

  const libraryPath = zoteroGroupId ? `/groups/${zoteroGroupId}` : `/users/${zoteroUserId}`;

  async function zoteroFetch(path, params = {}) {
    const url = new URL(`${BASE_URL}${libraryPath}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const { res, text } = await fetchTextWithLimits(url.toString(), {
      headers: { 'Zotero-API-Key': zoteroApiKey, 'Zotero-API-Version': API_VERSION },
    });
    if (!res.ok) {
      throw new Error(`Zotero API ${res.status}: ${text.slice(0, 200)}`);
    }
    return { json: JSON.parse(text), total: Number(res.headers.get('Total-Results') ?? 0) };
  }

  const items = [];
  let start = 0;
  while (items.length < safeLimit) {
    const fetchLimit = Math.min(PAGE_SIZE, safeLimit - items.length);
    const { json, total } = await zoteroFetch('/items', {
      itemType: '-attachment',
      start,
      limit: fetchLimit,
      sort: 'dateModified',
      direction: 'desc',
    });
    if (!Array.isArray(json) || json.length === 0) break;
    items.push(...json);
    start += json.length;
    if (start >= total) break;
  }

  const builder = new GraphBuilder();

  for (const item of items) {
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
        zoteroKey: data.key,
      },
    });

    for (const creator of (data.creators || [])) {
      const name = (creator.name || [creator.firstName, creator.lastName].filter(Boolean).join(' ')).trim();
      if (!name) continue;
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
    }

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
      builder.upsertEdge({ source: docNode.id, target: tagId, relation: 'TAGGED_WITH', weight: 0.4 });
    }

    for (const collectionKey of (data.collections || [])) {
      const collId = stableId('concept', `zotero-collection:${collectionKey}`);
      builder.upsertNode({
        id: collId,
        label: `Zotero Collection ${collectionKey}`,
        type: 'concept',
        sourceId: SOURCE_ID,
        metadata: { zoteroCollectionKey: collectionKey },
      });
      builder.upsertEdge({ source: docNode.id, target: collId, relation: 'PART_OF', weight: 0.5 });
    }
  }

  return { nodes: builder.nodes, edges: builder.edges, sourceId: SOURCE_ID };
}

// ── GitHub REST API ingester ──────────────────────────────────────────────────

/**
 * Fetch repos, issues, and PRs from the GitHub API using a personal access token.
 * @param {{ token: string, login?: string, reposLimit?: number, itemsLimit?: number }} opts
 * @returns {Promise<{ nodes: object[], edges: object[], sourceId: string }>}
 */
export async function ingestGithub({ token, login, reposLimit = 50, itemsLimit = 30 }) {
  const SOURCE_ID = 'github';
  const GH_API = 'https://api.github.com';

  const githubToken = String(token || '').trim();
  const safeReposLimit = clampPositiveInt(reposLimit, 50, 100);
  const safeItemsLimit = clampPositiveInt(itemsLimit, 30, 100);

  if (!githubToken) throw new Error('GITHUB_TOKEN is required');

  function ghFetch(path, params = {}) {
    const url = new URL(`${GH_API}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    return fetchTextWithLimits(url.toString(), {
      headers: {
        authorization: `Bearer ${githubToken}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
    });
  }

  async function ghJson(path, params = {}) {
    const { res, text } = await ghFetch(path, params);
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`GitHub API ${res.status}: ${text.slice(0, 200)}`);
    }
    return JSON.parse(text);
  }

  const requestedLogin = String(login || '').trim();
  const resolvedLogin = requestedLogin || (await ghJson('/user'))?.login;
  if (!resolvedLogin) throw new Error('Could not determine GitHub login — check your token');

  const allRepos = [];
  let page = 1;
  while (allRepos.length < safeReposLimit) {
    const perPage = Math.min(100, safeReposLimit - allRepos.length);
    const data = await ghJson(`/users/${resolvedLogin}/repos`, { sort: 'updated', per_page: perPage, page });
    if (!Array.isArray(data) || data.length === 0) break;
    allRepos.push(...data);
    if (data.length < perPage) break;
    page += 1;
  }

  const builder = new GraphBuilder();

  for (const repo of allRepos) {
    const repoId = stableId(SOURCE_ID, `repo:${repo.full_name}`);
    const topics = Array.isArray(repo.topics) ? repo.topics : [];

    builder.upsertNode({
      id: repoId,
      label: repo.full_name,
      type: 'repo',
      sourceId: SOURCE_ID,
      sourceUrl: repo.html_url,
      createdAt: repo.created_at || undefined,
      metadata: {
        description: repo.description ? repo.description.slice(0, 300) : undefined,
        language: repo.language || undefined,
        stars: repo.stargazers_count,
        forks: repo.forks_count,
        openIssues: repo.open_issues_count,
        private: repo.private,
        fork: repo.fork,
        topics,
      },
    });

    for (const topic of topics) {
      const tagId = stableId('tag', topic.toLowerCase());
      builder.upsertNode({
        id: tagId,
        label: `#${topic.toLowerCase()}`,
        type: 'tag',
        sourceId: SOURCE_ID,
        metadata: { tag: topic.toLowerCase() },
      });
      builder.upsertEdge({ source: repoId, target: tagId, relation: 'TAGGED_WITH', weight: 0.35 });
    }

    if (!repo.fork) {
      let items;
      try {
        const data = await ghJson(`/repos/${repo.full_name}/issues`, {
          state: 'all', per_page: Math.min(safeItemsLimit, 100), sort: 'updated',
        });
        items = Array.isArray(data) ? data.slice(0, safeItemsLimit) : [];
      } catch {
        items = [];
      }

      for (const item of items) {
        const isPr = !!item.pull_request;
        const itemId = stableId(SOURCE_ID, `${isPr ? 'pr' : 'issue'}:${repo.full_name}#${item.number}`);
        builder.upsertNode({
          id: itemId,
          label: `${repo.name}#${item.number}: ${(item.title || '').slice(0, 120)}`,
          type: isPr ? 'pr' : 'issue',
          sourceId: SOURCE_ID,
          sourceUrl: item.html_url,
          createdAt: item.created_at || undefined,
          metadata: {
            number: item.number,
            state: item.state,
            labels: (item.labels || []).map((l) => l.name),
            repo: repo.full_name,
          },
        });
        builder.upsertEdge({ source: itemId, target: repoId, relation: 'PART_OF', weight: 0.6 });

        if (item.user?.login) {
          const personId = stableId('person', item.user.login.toLowerCase());
          builder.upsertNode({
            id: personId,
            label: item.user.login,
            type: 'person',
            sourceId: SOURCE_ID,
            sourceUrl: item.user.html_url,
            metadata: { githubLogin: item.user.login },
          });
          builder.upsertEdge({ source: itemId, target: personId, relation: 'AUTHORED_BY', weight: 0.7 });
        }
      }
    }
  }

  return { nodes: builder.nodes, edges: builder.edges, sourceId: SOURCE_ID };
}

// ── Markdown / Obsidian vault parser ──────────────────────────────────────────

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

function basenameNoExt(path) {
  const slash = path.lastIndexOf('/');
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * Parse one Markdown file's text into a structured note record.
 * Mirrors scripts/ingest-markdown.mjs → parseMarkdownFile().
 */
function parseMarkdownText(text, filePath) {
  const { frontmatter, body } = splitFrontmatter(text);
  const fm = parseFrontmatter(frontmatter);

  const title = fm.title || basenameNoExt(filePath);
  const date = fm.date ? String(fm.date) : null;

  const tags = new Set(normaliseTags(fm.tags));
  for (const match of body.matchAll(/#([\w/-]+)/g)) {
    tags.add(match[1].toLowerCase());
  }

  const wikilinks = [];
  for (const match of body.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
    wikilinks.push(match[1].trim());
  }

  const urls = [];
  for (const match of body.matchAll(/\[[^\]]*\]\((https?:\/\/[^)]+)\)/g)) {
    urls.push(match[1]);
  }

  const aliases = normaliseTags(fm.aliases || fm.alias);
  const wordCount = body.split(/\s+/).filter(Boolean).length;

  return { filePath, title, date, tags: [...tags], wikilinks, urls, wordCount, aliases };
}

/**
 * Parse a collection of Markdown files (FileList or array of File) into a
 * graph of `note` and `tag` nodes plus `LINKS_TO` and `TAGGED` edges.
 * Mirrors the two-pass logic in scripts/ingest-markdown.mjs.
 *
 * @param {FileList|File[]} files
 * @returns {Promise<{ nodes: object[], edges: object[], sourceId: string }>}
 */
export async function parseMarkdownFiles(files) {
  const SOURCE_ID = 'markdown';
  const builder = new GraphBuilder();
  const list = Array.from(files || []).filter((f) => /\.md$/i.test(f.name));
  if (list.length === 0) return { nodes: [], edges: [], sourceId: SOURCE_ID };

  // First pass: read + parse every file, build wikilink lookup table.
  const parsedNotes = [];
  const noteTitleToId = new Map();

  for (const file of list) {
    const path = file.webkitRelativePath || file.name;
    let text;
    try { text = await file.text(); } catch { continue; }
    const parsed = parseMarkdownText(text, path);
    if (!parsed) continue;
    parsedNotes.push(parsed);
    const id = stableId('note', path);
    noteTitleToId.set(parsed.title.toLowerCase(), id);
    const stem = basenameNoExt(path).toLowerCase();
    if (!noteTitleToId.has(stem)) noteTitleToId.set(stem, id);
  }

  // Second pass: upsert nodes and edges.
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

    for (const tag of note.tags) {
      const tagId = stableId('tag', tag);
      builder.upsertNode({
        id: tagId,
        label: `#${tag}`,
        type: 'tag',
        sourceId: SOURCE_ID,
        metadata: { tag },
      });
      builder.upsertEdge({ source: noteId, target: tagId, relation: 'TAGGED', weight: 0.5 });
    }

    for (const link of note.wikilinks) {
      const targetId = noteTitleToId.get(link.toLowerCase());
      if (targetId && targetId !== noteId) {
        builder.upsertEdge({ source: noteId, target: targetId, relation: 'LINKS_TO', weight: 0.6 });
      }
    }
  }

  return { nodes: builder.nodes, edges: builder.edges, sourceId: SOURCE_ID };
}

// ── Daily-note generator ──────────────────────────────────────────────────────

function formatDateYMD(date) {
  return date.toISOString().slice(0, 10);
}

function adjustDay(date, delta) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + delta);
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

/**
 * Generate today's (or a given date's) daily note as a `note` graph node and
 * its associated `tag` nodes. Matches the structure produced by
 * scripts/ingest-daily-note.mjs but skips the filesystem write — the rendered
 * Markdown body is stored in `metadata.body` instead.
 *
 * @param {{ date?: string, tags?: string[]|string }} opts
 * @returns {{ nodes: object[], edges: object[], sourceId: string }}
 */
export function buildDailyNote({ date, tags } = {}) {
  const SOURCE_ID = 'markdown';
  const builder = new GraphBuilder();

  let dt;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((date || '').trim());
  if (m) dt = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  else dt = new Date();

  const dateStr = formatDateYMD(dt);
  const prevStr = formatDateYMD(adjustDay(dt, -1));
  const nextStr = formatDateYMD(adjustDay(dt, 1));

  const tagList = (Array.isArray(tags)
    ? tags
    : String(tags || 'daily,journal').split(',')
  ).map((t) => String(t).trim().toLowerCase()).filter(Boolean);

  const tagsYaml = tagList.map((t) => `  - ${t}`).join('\n');
  const body = `---
title: "${longDate(dt)}"
date: ${dateStr}
tags:
${tagsYaml}
---

# ${longDate(dt)}

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

  const filePath = `daily/${dateStr}.md`;
  const noteId = stableId('note', filePath);
  builder.upsertNode({
    id: noteId,
    label: longDate(dt),
    type: 'note',
    sourceId: SOURCE_ID,
    createdAt: dt.toISOString(),
    metadata: {
      path: filePath,
      wordCount: body.split(/\s+/).filter(Boolean).length,
      tags: tagList,
      daily: true,
      body,
    },
  });

  for (const tag of tagList) {
    const tagId = stableId('tag', tag);
    builder.upsertNode({
      id: tagId,
      label: `#${tag}`,
      type: 'tag',
      sourceId: SOURCE_ID,
      metadata: { tag },
    });
    builder.upsertEdge({ source: noteId, target: tagId, relation: 'TAGGED_WITH', weight: 0.5 });
  }

  // Wire wikilinks to neighbouring daily notes (if they already exist in the
  // graph, the Worker-side merge will resolve them; we emit speculative edges
  // here in case the user is bulk-generating a date range).
  for (const link of [prevStr, nextStr]) {
    const targetId = stableId('note', `daily/${link}.md`);
    builder.upsertEdge({ source: noteId, target: targetId, relation: 'LINKS_TO', weight: 0.6 });
  }

  return { nodes: builder.nodes, edges: builder.edges, sourceId: SOURCE_ID };
}

// ── Web-clip ingester (browser fetch) ─────────────────────────────────────────

function extractMetaContent(html, name) {
  const re = new RegExp(
    `<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']+)["']`,
    'i',
  );
  const m = re.exec(html) ||
    new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]*(?:name|property)=["']${name}["']`,
      'i',
    ).exec(html);
  return m ? m[1].trim() : null;
}

function stripPageHtml(html) {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script\b)<[^<]*)*<\/script[^>]*>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style\b)<[^<]*)*<\/style[^>]*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function extractPageBody(html) {
  const articleMatch =
    /<article[\s\S]*?>([\s\S]*?)<\/article>/i.exec(html) ||
    /<main[\s\S]*?>([\s\S]*?)<\/main>/i.exec(html);
  if (articleMatch) return stripPageHtml(articleMatch[1]);
  const paragraphs = [];
  const pRe = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = pRe.exec(html)) !== null) {
    const text = stripPageHtml(m[1]);
    if (text.length > 50) paragraphs.push(text);
  }
  if (paragraphs.length > 0) return paragraphs.join(' ');
  return stripPageHtml(html);
}

/**
 * Clip a list of URLs by fetching them from the browser. Mirrors
 * scripts/ingest-webclip.mjs but uses `fetch()` directly — which means the
 * target site must allow cross-origin reads (or be on the same origin as
 * the Graph SPA). Sites that don't set permissive CORS headers will fail
 * for that URL only; other URLs in the same batch still succeed.
 *
 * @param {string[]} urls
 * @returns {Promise<{ nodes: object[], edges: object[], sourceId: string, errors: object[] }>}
 */
export async function clipUrls(urls) {
  const SOURCE_ID = 'web_clip';
  const MAX_BODY_CHARS = 500;
  const builder = new GraphBuilder();
  const errors = [];

  const rawList = Array.isArray(urls) ? urls : String(urls || '').split(/[\n,]/);
  const deduped = [];
  const seen = new Set();
  for (const raw of rawList) {
    const trimmed = String(raw || '').trim();
    if (!trimmed) continue;
    let normalized;
    try {
      normalized = normalizePublicHttpUrl(trimmed);
    } catch (err) {
      errors.push({ url: trimmed, error: err.message || String(err) });
      continue;
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(normalized);
    if (deduped.length >= BROWSER_INGEST_LIMITS.maxRemoteUrls) break;
  }

  if (deduped.length === 0) {
    if (errors.length) return { nodes: [], edges: [], sourceId: SOURCE_ID, errors };
    throw new Error('Provide at least one public http(s) URL');
  }

  for (const url of deduped) {
    let html;
    try {
      const { res, text } = await fetchTextWithLimits(url, { mode: 'cors' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      html = text;
    } catch (err) {
      errors.push({ url, error: err.message || String(err) });
      continue;
    }

    let title;
    const ogTitle = extractMetaContent(html, 'og:title');
    if (ogTitle) {
      title = ogTitle;
    } else {
      const tm = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
      title = tm ? tm[1].trim() : new URL(url).hostname;
    }

    const description =
      extractMetaContent(html, 'og:description') ||
      extractMetaContent(html, 'description') ||
      null;

    const keywordsRaw = extractMetaContent(html, 'keywords');
    const keywords = keywordsRaw
      ? keywordsRaw
          .split(',')
          .map((k) => k.trim().toLowerCase())
          .filter((k) => k.length > 0 && k.length < 40)
      : [];

    const bodyText = extractPageBody(html);
    const excerpt = (description || bodyText).slice(0, MAX_BODY_CHARS);

    const nodeId = stableId(SOURCE_ID, url);
    builder.upsertNode({
      id: nodeId,
      label: (title || url).slice(0, 200),
      type: 'bookmark',
      sourceId: SOURCE_ID,
      sourceUrl: url,
      createdAt: new Date().toISOString(),
      metadata: { url, excerpt, keywords },
    });

    for (const keyword of keywords) {
      const tagId = stableId('tag', keyword);
      builder.upsertNode({
        id: tagId,
        label: `#${keyword}`,
        type: 'tag',
        sourceId: SOURCE_ID,
        metadata: { tag: keyword },
      });
      builder.upsertEdge({ source: nodeId, target: tagId, relation: 'TAGGED_WITH', weight: 0.4 });
    }
  }

  return { nodes: builder.nodes, edges: builder.edges, sourceId: SOURCE_ID, errors };
}

// ── Claude Code session-files parser ──────────────────────────────────────────

function ccExtractFilePaths(input) {
  const out = [];
  if (!input || typeof input !== 'object') return out;
  for (const v of Object.values(input)) {
    if (typeof v === 'string' && (v.startsWith('/') || /^[A-Za-z]:[\\/]/.test(v))) {
      out.push(v);
    }
  }
  return out;
}

function ccSessionLabel(session) {
  if (session.aiTitle) return String(session.aiTitle).slice(0, 120);
  if (session.summary) return String(session.summary).slice(0, 120);
  if (session.firstUserText) return String(session.firstUserText).slice(0, 120);
  return session.sessionId || 'Claude Code session';
}

async function ccReadSession(file) {
  let text;
  try { text = await file.text(); } catch { return null; }
  const lines = text.split('\n').filter(Boolean);
  if (lines.length === 0) return null;

  const tools = new Map();
  const files = new Map();
  const models = new Map();
  let messageCount = 0;
  let firstTimestamp = null;
  let lastTimestamp = null;
  let firstUserText = null;
  let summary = null;
  let aiTitle = null;
  let sessionId = null;
  let cwd = null;
  let gitBranch = null;

  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }

    sessionId = sessionId || entry.sessionId;
    cwd = cwd || entry.cwd;
    gitBranch = gitBranch || entry.gitBranch;

    if (entry.timestamp) {
      if (!firstTimestamp || entry.timestamp < firstTimestamp) firstTimestamp = entry.timestamp;
      if (!lastTimestamp  || entry.timestamp > lastTimestamp)  lastTimestamp  = entry.timestamp;
    }

    if (entry.type === 'summary' && entry.summary) summary = entry.summary;
    if (entry.type === 'ai-title' && (entry.title || entry.content)) {
      aiTitle = entry.title || entry.content;
    }

    if (entry.type !== 'user' && entry.type !== 'assistant') continue;
    const msg = entry.message;
    if (!msg || typeof msg !== 'object') continue;
    messageCount += 1;

    if (entry.type === 'assistant' && msg.model) {
      models.set(msg.model, (models.get(msg.model) || 0) + 1);
    }

    const content = msg.content;
    if (typeof content === 'string') {
      if (entry.type === 'user' && !firstUserText) firstUserText = content;
      continue;
    }
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && entry.type === 'user' && !firstUserText) {
        firstUserText = block.text;
      }
      if (block.type === 'tool_use') {
        const name = block.name;
        if (name) tools.set(name, (tools.get(name) || 0) + 1);
        for (const path of ccExtractFilePaths(block.input)) {
          files.set(path, (files.get(path) || 0) + 1);
        }
      }
    }
  }

  return {
    path: file.webkitRelativePath || file.name,
    sessionId,
    cwd,
    gitBranch,
    messageCount,
    firstTimestamp,
    lastTimestamp,
    firstUserText,
    summary,
    aiTitle,
    tools,
    files,
    models,
  };
}

/**
 * Parse a folder of Claude Code session JSONL files (typically uploaded from
 * `~/.claude/projects/<project>/`).  Mirrors scripts/ingest-claude-code.mjs:
 * groups sessions by their `cwd` into `project` nodes, and emits
 * `conversation`, `model`, `tool`, and `file` nodes with the same edge shapes.
 *
 * @param {FileList|File[]} files
 * @returns {Promise<{ nodes: object[], edges: object[], sourceId: string }>}
 */
export async function parseClaudeCodeSessions(files) {
  const SOURCE_ID = 'claude_code';
  const builder = new GraphBuilder();

  const list = Array.from(files || []).filter((f) => /\.jsonl$/i.test(f.name));
  if (list.length === 0) return { nodes: [], edges: [], sourceId: SOURCE_ID };

  // Group sessions by their immediate parent folder name (which is what
  // ~/.claude/projects/<folder>/*.jsonl looks like). Falls back to a single
  // bucket when uploads come in flat.
  const buckets = new Map();
  for (const file of list) {
    const rel = file.webkitRelativePath || file.name;
    const parts = rel.split('/');
    const folder = parts.length > 1 ? parts[parts.length - 2] : '_uploaded';
    if (!buckets.has(folder)) buckets.set(folder, []);
    buckets.get(folder).push(file);
  }

  for (const [folderName, bucketFiles] of buckets) {
    const sessionsAggregate = [];
    let projectCwd = null;
    for (const f of bucketFiles) {
      const session = await ccReadSession(f);
      if (!session) continue;
      if (session.cwd) projectCwd = session.cwd;
      sessionsAggregate.push(session);
    }
    if (sessionsAggregate.length === 0) continue;

    const projectKey = projectCwd || folderName;
    const projectId = stableId('project', projectKey);
    const projectLabel = projectCwd
      ? projectCwd.split('/').filter(Boolean).pop() || projectCwd
      : folderName.replace(/^-+/, '').replace(/-+/g, '/');

    builder.upsertNode({
      id: projectId,
      label: projectLabel,
      type: 'project',
      sourceId: SOURCE_ID,
      metadata: {
        cwd: projectCwd || null,
        folder: folderName,
        sessions: sessionsAggregate.length,
        messages: sessionsAggregate.reduce((s, x) => s + x.messageCount, 0),
      },
    });

    for (const session of sessionsAggregate) {
      const convId = stableId('conversation', session.sessionId || session.path);
      builder.upsertNode({
        id: convId,
        label: ccSessionLabel(session),
        type: 'conversation',
        sourceId: SOURCE_ID,
        createdAt: session.firstTimestamp,
        metadata: {
          sessionId: session.sessionId,
          messages: session.messageCount,
          firstTimestamp: session.firstTimestamp,
          lastTimestamp: session.lastTimestamp,
          gitBranch: session.gitBranch,
          cwd: session.cwd,
          path: session.path,
        },
      });
      builder.upsertEdge({ source: projectId, target: convId, relation: 'CONTAINS', weight: 0.6 });

      for (const [model, count] of session.models) {
        const modelId = stableId('model', model);
        builder.upsertNode({
          id: modelId,
          label: model,
          type: 'model',
          sourceId: SOURCE_ID,
          metadata: { provider: 'anthropic' },
        });
        builder.upsertEdge({
          source: convId,
          target: modelId,
          relation: 'USED_MODEL',
          weight: Math.min(1, 0.3 + count / 50),
          metadata: { count },
        });
      }

      for (const [tool, count] of session.tools) {
        const toolId = stableId('tool', tool);
        builder.upsertNode({
          id: toolId,
          label: tool,
          type: 'tool',
          sourceId: SOURCE_ID,
          metadata: { calls: count },
        });
        builder.upsertEdge({
          source: convId,
          target: toolId,
          relation: 'USED',
          weight: Math.min(1, 0.2 + count / 25),
          metadata: { count },
        });
      }

      for (const [path, count] of session.files) {
        const fileId = stableId('file', path);
        const fileBase = path.split('/').filter(Boolean).pop() || path;
        builder.upsertNode({
          id: fileId,
          label: fileBase,
          type: 'file',
          sourceId: SOURCE_ID,
          metadata: { path, touches: count },
        });
        builder.upsertEdge({
          source: convId,
          target: fileId,
          relation: 'TOUCHED',
          weight: Math.min(1, 0.2 + count / 10),
          metadata: { count },
        });
        if (projectCwd && path.startsWith(projectCwd)) {
          builder.upsertEdge({
            source: fileId,
            target: projectId,
            relation: 'PART_OF',
            weight: 0.4,
          });
        }
      }
    }
  }

  return { nodes: builder.nodes, edges: builder.edges, sourceId: SOURCE_ID };
}
