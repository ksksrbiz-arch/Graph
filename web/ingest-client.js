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
 *   parseBookmarks(html)                  — Netscape HTML bookmark export
 *   parseEnex(xml)                        — Evernote ENEX export
 *   parseClaudeExport(json)               — Claude.ai conversations.json
 *   ingestZotero({ userId, apiKey, ... }) — Zotero Web API (fetch from browser)
 *   ingestGithub({ token, login, ... })   — GitHub REST API (fetch from browser)
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
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/<[^>]*>/g, '')
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

  if (!userId || !apiKey) throw new Error('ZOTERO_USER_ID and ZOTERO_API_KEY are required');

  const libraryPath = groupId ? `/groups/${groupId}` : `/users/${userId}`;

  async function zoteroFetch(path, params = {}) {
    const url = new URL(`${BASE_URL}${libraryPath}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const res = await fetch(url.toString(), {
      headers: { 'Zotero-API-Key': apiKey, 'Zotero-API-Version': API_VERSION },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Zotero API ${res.status}: ${text.slice(0, 200)}`);
    }
    return { json: await res.json(), total: Number(res.headers.get('Total-Results') ?? 0) };
  }

  const items = [];
  let start = 0;
  while (items.length < limit) {
    const fetchLimit = Math.min(PAGE_SIZE, limit - items.length);
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
        id: tagId, label: `#${normTag}`, type: 'tag', sourceId: SOURCE_ID,
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

  if (!token) throw new Error('GITHUB_TOKEN is required');

  function ghFetch(path, params = {}) {
    const url = new URL(`${GH_API}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    return fetch(url.toString(), {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
    });
  }

  async function ghJson(path, params = {}) {
    const res = await ghFetch(path, params);
    if (res.status === 404) return null;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GitHub API ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  const resolvedLogin = login || (await ghJson('/user'))?.login;
  if (!resolvedLogin) throw new Error('Could not determine GitHub login — check your token');

  const allRepos = [];
  let page = 1;
  while (allRepos.length < reposLimit) {
    const perPage = Math.min(100, reposLimit - allRepos.length);
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
        id: tagId, label: `#${topic.toLowerCase()}`, type: 'tag', sourceId: SOURCE_ID,
        metadata: { tag: topic.toLowerCase() },
      });
      builder.upsertEdge({ source: repoId, target: tagId, relation: 'TAGGED_WITH', weight: 0.35 });
    }

    if (!repo.fork) {
      let items;
      try {
        const data = await ghJson(`/repos/${repo.full_name}/issues`, {
          state: 'all', per_page: Math.min(itemsLimit, 100), sort: 'updated',
        });
        items = Array.isArray(data) ? data.slice(0, itemsLimit) : [];
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
            id: personId, label: item.user.login, type: 'person', sourceId: SOURCE_ID,
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
