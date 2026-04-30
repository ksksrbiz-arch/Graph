// Extended ingest routes — sit in front of the existing
// /api/v1/public/ingest/{health,text,markdown,graph} surface and add five
// more dev-server-free ingestion paths backed by D1:
//
//   POST /api/v1/public/ingest/batch          — bulk {nodes, edges}
//   POST /api/v1/public/ingest/url            — server-side fetch + parse a URL
//   POST /api/v1/public/ingest/webhook/:id    — HMAC-verified webhook receiver
//   GET  /api/v1/public/events                — event log
//   GET  /api/v1/public/events/:id/payload    — raw event payload
//   GET  /api/v1/public/sources               — list registered sources
//   POST /api/v1/public/sources               — register source (returns webhook URL + secret)
//   GET  /api/v1/public/stats                 — counts by type/source
//
// All routes return null when they don't match — caller falls through to the
// existing ingest router or the static asset handler.

import { parseMarkdown, parseText } from './text-parser.js';
import {
  getEventPayload,
  getSource,
  listEvents,
  listSources,
  recordEvent,
  registerSource,
  statsByKind,
  touchSource,
  upsertNodesAndEdges,
  verifyWebhookSig,
} from './d1-store.js';

const MAX_URL_BYTES = 1_500_000; // 1.5 MB cap on a fetched page (we don't download images)
const FETCH_TIMEOUT_MS = 8_000;

export async function handleIngressApi(request, env, url) {
  const { pathname } = url;
  const method = request.method;

  // GET /api/v1/public/sources
  if (pathname === '/api/v1/public/sources' && method === 'GET') {
    const userId = (url.searchParams.get('userId') || '').trim();
    if (!userId) return jsonResponse({ error: 'userId query param is required' }, 400);
    return jsonResponse({ userId, sources: await listSources(env.GRAPH_DB, { userId }) });
  }

  // POST /api/v1/public/sources
  if (pathname === '/api/v1/public/sources' && method === 'POST') {
    const dto = await safeJson(request);
    if (!dto) return jsonResponse({ error: 'invalid JSON body' }, 400);
    if (!checkUser(dto.userId, env)) return forbidden(dto.userId);
    if (!dto.kind || !dto.label) {
      return jsonResponse({ error: 'kind and label are required' }, 400);
    }
    const { id, secret } = await registerSource(env.GRAPH_DB, {
      userId: dto.userId.trim(),
      kind: String(dto.kind).slice(0, 60),
      label: String(dto.label).slice(0, 200),
      config: dto.config ?? {},
    });
    return jsonResponse({
      id,
      webhookUrl: `${url.origin}/api/v1/public/ingest/webhook/${id}`,
      secret, // shown ONCE — caller must store it
      hint: 'Send POST with header "x-pkg-signature: <hmac-sha256-hex(secret, body)>"',
    });
  }

  // GET /api/v1/public/events
  if (pathname === '/api/v1/public/events' && method === 'GET') {
    const userId = (url.searchParams.get('userId') || '').trim();
    if (!userId) return jsonResponse({ error: 'userId query param is required' }, 400);
    return jsonResponse({
      userId,
      events: await listEvents(env.GRAPH_DB, {
        userId,
        since: url.searchParams.get('since'),
        sourceKind: url.searchParams.get('sourceKind'),
        limit: parseInt(url.searchParams.get('limit') || '50', 10),
      }),
    });
  }

  // GET /api/v1/public/events/:id/payload
  const payloadMatch = pathname.match(/^\/api\/v1\/public\/events\/([^\/]+)\/payload$/);
  if (payloadMatch && method === 'GET') {
    const userId = (url.searchParams.get('userId') || '').trim();
    if (!userId) return jsonResponse({ error: 'userId query param is required' }, 400);
    const row = await getEventPayload(env.GRAPH_DB, { userId, eventId: payloadMatch[1] });
    if (!row) return jsonResponse({ error: 'not found' }, 404);
    let parsed;
    try { parsed = JSON.parse(row.payload_json); } catch { parsed = row.payload_json; }
    return jsonResponse({ eventId: payloadMatch[1], payload: parsed });
  }

  // GET /api/v1/public/stats
  if (pathname === '/api/v1/public/stats' && method === 'GET') {
    const userId = (url.searchParams.get('userId') || '').trim();
    if (!userId) return jsonResponse({ error: 'userId query param is required' }, 400);
    return jsonResponse({ userId, ...(await statsByKind(env.GRAPH_DB, { userId })) });
  }

  // POST /api/v1/public/ingest/batch  — bulk pre-shaped {nodes, edges}
  if (pathname === '/api/v1/public/ingest/batch' && method === 'POST') {
    const dto = await safeJson(request);
    if (!dto) return jsonResponse({ error: 'invalid JSON body' }, 400);
    if (!checkUser(dto.userId, env)) return forbidden(dto.userId);
    if (!Array.isArray(dto.nodes)) {
      return jsonResponse({ error: 'nodes array is required' }, 400);
    }
    const sourceKind = String(dto.sourceKind || 'batch').slice(0, 60);
    return persistAndLog({
      env,
      userId: dto.userId.trim(),
      sourceId: dto.sourceId,
      sourceKind,
      kind: 'batch',
      payload: { sourceKind, nodes: dto.nodes.length, edges: dto.edges?.length ?? 0 },
      parsed: { nodes: dto.nodes, edges: dto.edges ?? [] },
    });
  }

  // POST /api/v1/public/ingest/url — server fetches the page and parses it
  if (pathname === '/api/v1/public/ingest/url' && method === 'POST') {
    const dto = await safeJson(request);
    if (!dto) return jsonResponse({ error: 'invalid JSON body' }, 400);
    if (!checkUser(dto.userId, env)) return forbidden(dto.userId);
    const target = (dto.url || '').toString().trim();
    if (!target || !/^https?:\/\//i.test(target)) {
      return jsonResponse({ error: 'url must start with http(s)://' }, 400);
    }

    let fetched;
    try {
      fetched = await fetchPage(target);
    } catch (err) {
      return jsonResponse({ error: `fetch failed: ${err.message}` }, 502);
    }

    const userId = dto.userId.trim();
    const title = dto.title || fetched.title || target;
    const note = dto.selection || fetched.text;
    const parsed = await parseText(`${title}\n\n${note}\n\nSource: ${target}`, {
      userId,
      sourceId: 'webclip',
      title,
    });

    return persistAndLog({
      env,
      userId,
      sourceId: 'webclip',
      sourceKind: 'url',
      kind: 'url',
      payload: { url: target, title, contentLength: note.length },
      parsed,
    });
  }

  // POST /api/v1/public/ingest/webhook/:sourceId  — signed webhook
  const hookMatch = pathname.match(/^\/api\/v1\/public\/ingest\/webhook\/([^\/]+)$/);
  if (hookMatch && method === 'POST') {
    if (!env.GRAPH_DB) return jsonResponse({ error: 'persistence not configured' }, 503);
    const sourceId = hookMatch[1];
    const source = await getSource(env.GRAPH_DB, { sourceId });
    if (!source) return jsonResponse({ error: 'unknown source' }, 404);

    const sig = request.headers.get('x-pkg-signature');
    const rawBody = await request.text();
    if (!(await verifyWebhookSig(source.webhook_secret, rawBody, sig))) {
      return jsonResponse({ error: 'bad signature' }, 401);
    }

    let dto;
    try { dto = JSON.parse(rawBody); } catch { return jsonResponse({ error: 'invalid JSON body' }, 400); }

    // Webhooks can carry either {nodes, edges} or {text} or {markdown}
    let parsed;
    if (Array.isArray(dto.nodes)) {
      parsed = { nodes: dto.nodes, edges: dto.edges ?? [] };
    } else if (typeof dto.markdown === 'string') {
      parsed = await parseMarkdown(dto.markdown, {
        userId: source.user_id,
        sourceId: source.kind,
        title: dto.title || source.label,
      });
    } else if (typeof dto.text === 'string') {
      parsed = await parseText(dto.text, {
        userId: source.user_id,
        sourceId: source.kind,
        title: dto.title || source.label,
      });
    } else {
      return jsonResponse({ error: 'webhook body must contain nodes/edges, text, or markdown' }, 400);
    }

    await touchSource(env.GRAPH_DB, { sourceId });

    return persistAndLog({
      env,
      userId: source.user_id,
      sourceId: source.id,
      sourceKind: source.kind,
      kind: 'webhook',
      payload: { kind: source.kind, label: source.label, bytes: rawBody.length },
      parsed,
    });
  }

  return null;
}

// ── shared persist + log helper ───────────────────────────────────────

/**
 * Hand off to the KV merge + persist (declared in src/worker.js) and ALSO
 * write the event + flat projection to D1. The KV write is the source of
 * truth for the SPA's first paint; D1 is the source of truth for SQL.
 *
 * The KV merge function is injected via env (see src/worker.js → handleApi)
 * to avoid a circular import.
 */
export async function persistAndLog({ env, userId, sourceId, sourceKind, kind, payload, parsed }) {
  const mergeFn = env.__mergeAndPersist;
  if (typeof mergeFn !== 'function') {
    return jsonResponse({ error: 'KV persistence not wired' }, 500);
  }

  let snapshot;
  try {
    snapshot = await mergeFn(env.GRAPH_KV, userId, parsed, sourceKind);
  } catch (err) {
    if (env.GRAPH_DB) {
      await recordEvent(env.GRAPH_DB, {
        userId, sourceId, sourceKind, kind,
        payload, nodeCount: parsed.nodes?.length ?? 0,
        edgeCount: parsed.edges?.length ?? 0,
        status: 'error', error: err.message,
      });
    }
    return jsonResponse({ error: `persist failed: ${err.message}` }, 500);
  }

  let evtRow = null;
  if (env.GRAPH_DB) {
    try {
      const [evt] = await Promise.all([
        recordEvent(env.GRAPH_DB, {
          userId, sourceId, sourceKind, kind,
          payload,
          nodeCount: parsed.nodes?.length ?? 0,
          edgeCount: parsed.edges?.length ?? 0,
          status: 'applied',
        }),
        upsertNodesAndEdges(env.GRAPH_DB, {
          userId, sourceKind,
          nodes: parsed.nodes,
          edges: parsed.edges,
        }),
      ]);
      evtRow = evt;
    } catch (err) {
      // D1 errors don't block KV writes — KV is already persisted at this point.
      console.warn('[d1] event log write failed:', err.message);
    }
  }

  return jsonResponse({
    ok: true,
    userId,
    kind,
    eventId: evtRow?.id ?? null,
    deduped: evtRow?.deduped ?? false,
    nodes: parsed.nodes?.length ?? 0,
    edges: parsed.edges?.length ?? 0,
    totalNodes: snapshot.nodes.length,
    totalEdges: snapshot.edges.length,
  });
}

// ── helpers ───────────────────────────────────────────────────────────

async function fetchPage(targetUrl) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(targetUrl, {
      redirect: 'follow',
      signal: ctl.signal,
      headers: {
        'user-agent':
          'Mozilla/5.0 (compatible; PKG-Ingest/1.0; +https://graph.skdev-371.workers.dev)',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    if (!res.ok) throw new Error(`upstream returned HTTP ${res.status}`);
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!ct.startsWith('text/') && !ct.includes('json') && !ct.includes('xml')) {
      throw new Error(`unsupported content-type: ${ct || 'unknown'}`);
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_URL_BYTES) {
      throw new Error(`response exceeds ${MAX_URL_BYTES} bytes (got ${buf.byteLength})`);
    }
    const html = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    return { title: extractTitle(html), text: extractReadableText(html) };
  } finally {
    clearTimeout(timer);
  }
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return m?.[1]?.trim().slice(0, 200) || null;
}

function extractReadableText(html) {
  // Strip script/style/nav/footer/header, then collapse the rest. Crude but
  // deterministic — avoids pulling in a 200KB readability lib at the edge.
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.slice(0, 50_000);
}

async function safeJson(request) {
  try { return await request.json(); } catch { return null; }
}

function checkUser(userId, env) {
  if (!userId || typeof userId !== 'string') return false;
  const csv = (env.PUBLIC_INGEST_USER_IDS || 'local').toString();
  return csv.split(',').map((s) => s.trim()).filter(Boolean).includes(userId.trim());
}

function forbidden(userId) {
  return jsonResponse({ error: `userId=${userId ?? '(empty)'} is not on the public ingest allowlist` }, 403);
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
