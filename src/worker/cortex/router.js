// Cortex compositor router. Mounted from src/worker.js → handleApi.
// Owns:
//   POST /api/v1/cortex/perceive
//   POST /api/v1/cortex/think
//   GET  /api/v1/cortex/state?userId=…
//   POST /api/v1/cortex/act/:tool
//   GET  /api/v1/cortex/tools
//
// Returns null when path doesn't match — caller falls through to ingress
// router and then static assets.

import { recordEvent, upsertNodesAndEdges } from '../d1-store.js';
import { parseMarkdown, parseText } from '../text-parser.js';
import { readAttention, writeAttention } from './attention.js';
import { stamp, isPerceive, isThink, isAct } from './protocol.js';
import { describeTools, dispatch } from './tools.js';
import { upsertNodes as upsertVectors } from './vector.js';
import { CRON_PLAYBOOK, listSchedules, runSchedule } from './scheduler.js';
import { think } from './reason.js';

export async function handleCortexApi(request, env, url) {
  const { pathname } = url;
  const method = request.method;

  if (pathname === '/api/v1/cortex/tools' && method === 'GET') {
    return jsonResponse({ tools: describeTools() });
  }

  if (pathname === '/api/v1/cortex/state' && method === 'GET') {
    const userId = need(url, 'userId');
    if (!userId) return jsonResponse({ error: 'userId required' }, 400);
    if (!checkUser(userId, env)) return forbidden(userId);
    const att = await readAttention(env.GRAPH_KV, userId);
    return jsonResponse({ attention: att });
  }

  if (pathname === '/api/v1/cortex/perceive' && method === 'POST') {
    const dto = await safeJson(request);
    if (!dto) return jsonResponse({ error: 'invalid JSON body' }, 400);
    const msg = stamp(dto, { clientFallback: 'unknown' });
    if (!isPerceive(msg)) return jsonResponse({ error: 'not a perceive message (missing kind/modality)' }, 400);
    const userId = (msg.userId || msg.payload?.userId || 'local').toString().trim();
    if (!checkUser(userId, env)) return forbidden(userId);
    const result = await perceive(env, userId, msg);
    return jsonResponse(result, result.ok === false ? 400 : 200);
  }

  if (pathname === '/api/v1/cortex/think' && method === 'POST') {
    const dto = await safeJson(request);
    if (!dto) return jsonResponse({ error: 'invalid JSON body' }, 400);
    const msg = stamp(dto, { clientFallback: 'unknown' });
    if (!isThink(msg)) return jsonResponse({ error: 'not a think message' }, 400);
    const userId = (msg.userId || 'local').toString().trim();
    if (!checkUser(userId, env)) return forbidden(userId);
    const out = await think(env, {
      userId,
      question: msg.question,
      budgetMs: msg.budgetMs,
      budgetSteps: msg.budgetSteps,
      model: msg.model,
    });
    // Mirror the think into the event log so the timeline shows it
    if (env.GRAPH_DB) {
      await recordEvent(env.GRAPH_DB, {
        userId, sourceKind: 'cortex', kind: 'think',
        payload: { question: msg.question, finalAnswer: out.finalAnswer, steps: out.trace?.length },
        nodeCount: 0, edgeCount: 0,
        status: out.ok ? 'applied' : 'error',
        error: out.ok ? null : out.error,
      });
    }
    return jsonResponse(out);
  }

  const actMatch = pathname.match(/^\/api\/v1\/cortex\/act\/([a-z0-9_-]+)$/);
  if (actMatch && method === 'POST') {
    const intent = actMatch[1];
    const dto = await safeJson(request);
    const userId = (dto?.userId || 'local').toString().trim();
    if (!checkUser(userId, env)) return forbidden(userId);
    const result = await dispatch(env, intent, dto?.args || {}, { userId });
    return jsonResponse(result);
  }

  // GET /api/v1/cortex/schedules — list configured cron cadences + last-run watermarks
  if (pathname === '/api/v1/cortex/schedules' && method === 'GET') {
    const userId = need(url, 'userId') || 'local';
    if (!checkUser(userId, env)) return forbidden(userId);
    const schedules = listSchedules();
    if (env.GRAPH_KV) {
      for (const sch of schedules) {
        const ts = await env.GRAPH_KV.get('schedule:' + userId + ':' + sch.name + ':lastRun');
        sch.lastRun = ts ? parseInt(ts, 10) : null;
      }
    }
    return jsonResponse({ userId, schedules });
  }

  // POST /api/v1/cortex/schedules/:name/run — manually trigger a scheduled think
  // Body: {userId, force?: boolean}
  const schedRunMatch = pathname.match(/^\/api\/v1\/cortex\/schedules\/([a-z0-9_-]+)\/run$/);
  if (schedRunMatch && method === 'POST') {
    const dto = (await safeJson(request)) || {};
    const userId = (dto.userId || 'local').toString().trim();
    if (!checkUser(userId, env)) return forbidden(userId);
    const out = await runSchedule({ env, userId, name: schedRunMatch[1], force: !!dto.force });
    return jsonResponse(out);
  }

  // GET /api/v1/cortex/scheduled-thoughts?userId=… — recent autonomous thoughts
  if (pathname === '/api/v1/cortex/scheduled-thoughts' && method === 'GET') {
    const userId = need(url, 'userId') || 'local';
    if (!checkUser(userId, env)) return forbidden(userId);
    if (!env.GRAPH_DB) return jsonResponse({ error: 'GRAPH_DB binding missing' }, 503);
    const limit = clampInt(parseInt(url.searchParams.get('limit') || '20', 10), 1, 200, 20);
    const sql = "SELECT id, ts, payload_json, status, error FROM events " +
                "WHERE user_id = ?1 AND kind = 'scheduled-think' " +
                "ORDER BY ts DESC LIMIT " + limit;
    const { results } = await env.GRAPH_DB.prepare(sql).bind(userId).all();
    const thoughts = (results || []).map((r) => {
      let payload = {};
      try { payload = JSON.parse(r.payload_json); } catch {}
      return {
        id: r.id, ts: r.ts, status: r.status, error: r.error,
        schedule: payload.schedule, finalAnswer: payload.finalAnswer,
        steps: payload.steps, elapsedMs: payload.elapsedMs, newCount: payload.newCount,
      };
    });
    return jsonResponse({ userId, thoughts });
  }

  // POST /api/v1/cortex/admin/backfill-vectors — embed every D1 node
  // for a user into Vectorize. Idempotent — vector ids are deterministic.
  // Body: {userId, batch?: number, sinceTs?: number}
  if (pathname === '/api/v1/cortex/admin/backfill-vectors' && method === 'POST') {
    const dto = await safeJson(request);
    const userId = (dto?.userId || 'local').toString().trim();
    if (!checkUser(userId, env)) return forbidden(userId);
    if (!env.GRAPH_DB) return jsonResponse({ error: 'GRAPH_DB binding missing' }, 503);
    if (!env.VECTORS || !env.AI) return jsonResponse({ error: 'VECTORS or AI binding missing' }, 503);
    const batch = clampInt(dto?.batch, 50, 1000, 200);
    const sinceTs = Number(dto?.sinceTs || 0);
    let cursor = null;
    let total = 0;
    let written = 0;
    const startedAt = Date.now();
    // Walk D1 nodes in batches keyed by last_seen_at so we get newest first
    // and can resume by passing sinceTs from the prior call.
    for (let page = 0; page < 200; page++) {
      const where = ['user_id = ?'];
      const params = [userId];
      if (cursor !== null) { where.push('last_seen_at < ?'); params.push(cursor); }
      else if (sinceTs)    { where.push('last_seen_at >= ?'); params.push(sinceTs); }
      const sql = 'SELECT id, type, label, data_json, source_kind, last_seen_at FROM nodes WHERE ' + where.join(' AND ') + ' ORDER BY last_seen_at DESC LIMIT ' + batch;
      const { results } = await env.GRAPH_DB.prepare(sql).bind(...params).all();
      const rows = results || [];
      if (!rows.length) break;
      const nodes = rows.map((r) => ({
        id: r.id,
        type: r.type,
        label: r.label,
        sourceKind: r.source_kind,
        metadata: safeJson_(r.data_json),
      }));
      try {
        const w = await upsertVectors(env, userId, nodes);
        written += w;
      } catch (err) {
        console.warn('[backfill] batch failed:', err.message);
      }
      total += rows.length;
      cursor = rows[rows.length - 1].last_seen_at;
      if (Date.now() - startedAt > 25_000) break; // stay under sub-request budget
      if (rows.length < batch) break;
    }
    return jsonResponse({ ok: true, total, written, elapsedMs: Date.now() - startedAt, nextCursor: cursor });
  }

  return null;
}

function clampInt(v, lo, hi, dflt) {
  const n = Number.isFinite(+v) ? Math.floor(+v) : dflt;
  return Math.max(lo, Math.min(hi, n));
}
function safeJson_(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

// ── perceive dispatcher ──────────────────────────────────────────────
//
// Routes a generic perceive message to the matching ingest path. Mirrors
// the result into the event log + attention focus so the next /think
// picks up the new perception.

async function perceive(env, userId, msg) {
  const merge = env.__mergeAndPersist;
  if (typeof merge !== 'function' || !env.GRAPH_KV) {
    return { ok: false, error: 'KV merge not wired' };
  }
  let parsed;
  let payload = msg.payload || {};
  let kind = msg.modality;
  let transcript = null;
  let caption = null;

  if (msg.modality === 'text') {
    const text = (payload.text || '').toString();
    if (!text.trim()) return { ok: false, error: 'text required' };
    parsed = await parseText(text, {
      userId, sourceId: msg.source || 'perceive',
      title: payload.title || `Perceived text — ${new Date().toISOString().slice(0, 19)}`,
    });
  } else if (msg.modality === 'url') {
    // We just record the URL as a single bookmark node; full server-side
    // fetching lives in the existing /api/v1/public/ingest/url path. Clients
    // that want fetch-and-parse should call that route directly.
    const url = (payload.url || '').toString();
    if (!/^https?:\/\//.test(url)) return { ok: false, error: 'url must be http(s)://' };
    parsed = await parseText(`${payload.title || url}\n\n${payload.selection || ''}\n\n${url}`, {
      userId, sourceId: 'webclip',
      title: payload.title || url,
    });
  } else if (msg.modality === 'graph') {
    if (!Array.isArray(payload.nodes)) return { ok: false, error: 'graph payload must have nodes[]' };
    parsed = { nodes: payload.nodes, edges: payload.edges || [] };
  } else if (msg.modality === 'voice') {
    // Layer 7: audio blob (base64) → Whisper transcription → text nodes.
    if (!env.AI) return { ok: false, error: 'AI binding required for voice transcription' };
    const audioB64 = payload.audio;
    if (!audioB64 || typeof audioB64 !== 'string') {
      return { ok: false, error: 'voice payload must include audio as a base64 string' };
    }
    let audioBytes;
    try {
      audioBytes = base64ToBytes(audioB64);
    } catch {
      return { ok: false, error: 'audio must be valid base64' };
    }
    try {
      const result = await env.AI.run('@cf/openai/whisper', { audio: [...audioBytes] });
      transcript = (result?.text || '').trim();
    } catch (err) {
      return { ok: false, error: `whisper failed: ${err.message}` };
    }
    if (!transcript) return { ok: false, error: 'whisper returned an empty transcript' };
    parsed = await parseText(transcript, {
      userId, sourceId: msg.source || 'voice',
      title: payload.title || `Voice note — ${isoStamp()}`,
    });
    // Stash the raw transcript on the first node so callers can surface it.
    if (parsed.nodes?.[0]) {
      parsed.nodes[0].metadata = { ...parsed.nodes[0].metadata, transcript };
    }
    kind = 'voice';
  } else if (msg.modality === 'vision') {
    // Layer 8: image blob (base64) → LLaVA caption → text nodes.
    if (!env.AI) return { ok: false, error: 'AI binding required for vision captioning' };
    const imageB64 = payload.image;
    if (!imageB64 || typeof imageB64 !== 'string') {
      return { ok: false, error: 'vision payload must include image as a base64 string' };
    }
    let imageBytes;
    try {
      imageBytes = base64ToBytes(imageB64);
    } catch {
      return { ok: false, error: 'image must be valid base64' };
    }
    try {
      const result = await env.AI.run('@cf/llava-hf/llava-1.5-7b-hf', {
        image: [...imageBytes],
        prompt: payload.prompt || 'Describe this image in detail.',
        max_tokens: 512,
      });
      caption = (result?.description || '').trim();
    } catch (err) {
      return { ok: false, error: `llava failed: ${err.message}` };
    }
    if (!caption) return { ok: false, error: 'llava returned an empty caption' };
    parsed = await parseText(caption, {
      userId, sourceId: msg.source || 'vision',
      title: payload.title || `Vision note — ${isoStamp()}`,
    });
    // Stash the raw caption on the first node so callers can surface it.
    if (parsed.nodes?.[0]) {
      parsed.nodes[0].metadata = { ...parsed.nodes[0].metadata, caption };
    }
    kind = 'vision';
  } else if (msg.modality === 'webhook' || msg.modality === 'event') {
    // Treat as a structured event — record it but don't graph-mutate unless
    // the payload contains nodes.
    parsed = { nodes: payload.nodes || [], edges: payload.edges || [] };
  } else {
    return { ok: false, error: `modality not yet supported in compositor: ${msg.modality}` };
  }

  const snap = await merge(env.GRAPH_KV, userId, parsed, msg.source || msg.modality);

  let evtRow = null;
  if (env.GRAPH_DB) {
    // Strip heavy binary fields (base64 audio/image) from the event log payload.
    const { audio: _audio, image: _image, ...safePayload } = payload;
    if (transcript !== null) safePayload.transcript = transcript;
    if (caption    !== null) safePayload.caption    = caption;
    const [e] = await Promise.all([
      recordEvent(env.GRAPH_DB, {
        userId, sourceKind: msg.modality, kind,
        payload: { source: msg.source, ...safePayload },
        nodeCount: parsed.nodes?.length ?? 0,
        edgeCount: parsed.edges?.length ?? 0,
        status: 'applied',
      }),
      upsertNodesAndEdges(env.GRAPH_DB, {
        userId, sourceKind: msg.modality,
        nodes: parsed.nodes, edges: parsed.edges,
      }),
    ]);
    evtRow = e;
  }

  // Update attention: focus on whatever this perception added.
  const focusIds = (parsed.nodes || []).slice(0, 8).map((n) => n.id).filter(Boolean);
  await writeAttention(env.GRAPH_KV, userId, {
    focus: focusIds,
    recentEvents: evtRow ? [evtRow.id] : [],
  });

  return {
    ok: true,
    modality: msg.modality,
    eventId: evtRow?.id ?? null,
    deduped: evtRow?.deduped ?? false,
    nodes: parsed.nodes?.length ?? 0,
    edges: parsed.edges?.length ?? 0,
    totalNodes: snap.nodes.length,
    totalEdges: snap.edges.length,
    ...(transcript !== null && { transcript }),
    ...(caption    !== null && { caption }),
  };
}

// ── helpers ───────────────────────────────────────────────────────────

async function safeJson(request) {
  try { return await request.json(); } catch { return null; }
}
function need(url, key) {
  const v = (url.searchParams.get(key) || '').trim();
  return v || null;
}
function checkUser(userId, env) {
  if (!userId) return false;
  const csv = (env.PUBLIC_INGEST_USER_IDS || 'local').toString();
  return csv.split(',').map((s) => s.trim()).filter(Boolean).includes(userId);
}
function forbidden(userId) {
  return jsonResponse({ error: `userId=${userId ?? '(empty)'} not on allowlist` }, 403);
}
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** Decode a base64 string to a Uint8Array. Throws on invalid input. */
function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Return the current time as a compact ISO-8601 string (seconds precision). */
function isoStamp() {
  return new Date().toISOString().slice(0, 19);
}
