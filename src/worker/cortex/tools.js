// Cortex tool registry. Each tool is a pure-ish async function:
//
//   (env, args, opts) => Promise<{ ok: boolean, result?: any, error?: string }>
//
// New tools = new entry in REGISTRY. The reasoner discovers them via
// describeTools() and routes act() calls via dispatch().
//
// Built-ins (Stage 1):
//   recent-events   — pull last N D1 events
//   graph-query     — read-only flat-projection query against D1 nodes/edges
//   web-fetch       — server fetches a URL, returns extracted readable text
//   write-note      — persist a note as text → KV graph + D1 event mirror
//   summarize       — LLM-summarize a chunk of text via Workers AI
//
// Finance tools (APC Phase 1):
//   finance-queue   — fetch the AP approval queue (pending bills + proposals)
//   list-bills      — list bills filtered by status/vendor
//   get-vendor      — look up a vendor by name or ID
//   finance-summary — summarize current AP position (totals, overdue, tax)

import { listEvents, recordEvent, upsertNodesAndEdges } from '../d1-store.js';
import { parseText } from '../text-parser.js';
import { recall as vectorRecall } from './vector.js';
import { speakText } from './sensory.js';
import { describeMcpTools, dispatchMcpTool } from './mcp-registry.js';
import { getApprovalQueue, listBills, listVendors, listTaxLiabilities } from '../finance/store.js';

const FETCH_TIMEOUT_MS = 8_000;
const MAX_URL_BYTES = 1_500_000;

export const REGISTRY = {
  'recent-events': {
    intent: 'recent-events',
    description: 'List the last N events for the current user. Args: {limit?: number, sourceKind?: string, since?: number}.',
    async run(env, args, { userId }) {
      const events = await listEvents(env.GRAPH_DB, {
        userId,
        limit: clampInt(args?.limit, 1, 50, 10),
        sourceKind: args?.sourceKind ? String(args.sourceKind) : undefined,
        since: args?.since ? Number(args.since) : undefined,
      });
      return { ok: true, result: { events } };
    },
  },

  'recall': {
    intent: 'recall',
    description: 'Semantic recall over the user\'s connectome via vector embeddings. Args: {query: string, topK?: number}. Returns the most semantically similar nodes — use this when graph-query (substring match) misses the concept.',
    async run(env, args, { userId }) {
      const out = await vectorRecall(env, userId, (args?.query || '').toString(), { topK: args?.topK });
      return out.ok ? { ok: true, result: { matches: out.matches } } : { ok: false, error: out.error };
    },
  },

  'graph-query': {
    intent: 'graph-query',
    description: 'Search the user\'s flat node/edge projection. Args: {label?: string, type?: string, limit?: number}.',
    async run(env, args, { userId }) {
      if (!env.GRAPH_DB) return { ok: false, error: 'GRAPH_DB binding missing' };
      const limit = clampInt(args?.limit, 1, 50, 10);
      const where = ['user_id = ?'];
      const params = [userId];
      if (args?.label) {
        where.push('label LIKE ?');
        params.push(`%${String(args.label).slice(0, 80)}%`);
      }
      if (args?.type) {
        where.push('type = ?');
        params.push(String(args.type).slice(0, 40));
      }
      const sql = `SELECT id, type, label, source_kind, last_seen_at
                   FROM nodes WHERE ${where.join(' AND ')}
                   ORDER BY last_seen_at DESC LIMIT ${limit}`;
      const { results } = await env.GRAPH_DB.prepare(sql).bind(...params).all();
      return { ok: true, result: { nodes: results || [] } };
    },
  },

  'web-fetch': {
    intent: 'web-fetch',
    description: 'Fetch a URL and return readable text + title. Args: {url: string}.',
    async run(_env, args) {
      const url = (args?.url || '').toString().trim();
      if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'url must be http(s)://' };
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
        const res = await fetch(url, {
          signal: ctl.signal, redirect: 'follow',
          headers: { 'user-agent': 'Mozilla/5.0 (compatible; PKG-Cortex/1.0)' },
        });
        clearTimeout(t);
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        const buf = await res.arrayBuffer();
        if (buf.byteLength > MAX_URL_BYTES) return { ok: false, error: `> ${MAX_URL_BYTES} bytes` };
        const html = new TextDecoder('utf-8', { fatal: false }).decode(buf);
        return { ok: true, result: { url, title: title(html), text: readable(html).slice(0, 8_000) } };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
  },

  'write-note': {
    intent: 'write-note',
    description: 'Persist a free-form note into the graph. Args: {title?: string, text: string}.',
    async run(env, args, { userId }) {
      const text = (args?.text || '').toString();
      if (!text.trim()) return { ok: false, error: 'text is required' };
      const title = (args?.title || `Note — ${new Date().toISOString().slice(0, 19)}`).toString().slice(0, 200);
      const parsed = await parseText(text, { userId, sourceId: 'cortex', title });
      const merge = env.__mergeAndPersist;
      if (typeof merge === 'function' && env.GRAPH_KV) {
        const snap = await merge(env.GRAPH_KV, userId, parsed, 'cortex');
        if (env.GRAPH_DB) {
          await Promise.all([
            recordEvent(env.GRAPH_DB, {
              userId, sourceKind: 'cortex', kind: 'write-note',
              payload: { title, length: text.length },
              nodeCount: parsed.nodes.length,
              edgeCount: parsed.edges.length,
              status: 'applied',
            }),
            upsertNodesAndEdges(env.GRAPH_DB, {
              userId, sourceKind: 'cortex',
              nodes: parsed.nodes, edges: parsed.edges,
            }),
          ]);
        }
        return { ok: true, result: {
          parentId: parsed.parentId, addedNodes: parsed.nodes.length,
          totalNodes: snap.nodes.length, totalEdges: snap.edges.length,
        } };
      }
      return { ok: false, error: 'KV merge not wired' };
    },
  },

  'speak': {
    intent: 'speak',
    description: 'Synthesize speech from text via Workers AI Aura-1 (TTS, voice asteria default). Args: {text: string, voice?: string}. Returns {audioBase64, mimeType, voice} the SPA plays inline. Use only when the user asked the cortex to speak — not for every answer.',
    async run(env, args) {
      const out = await speakText(env, (args?.text || '').toString(), { voice: args?.voice });
      if (!out.ok) return { ok: false, error: out.error };
      return { ok: true, result: { audioBase64: out.audioBase64, mimeType: out.mimeType, voice: out.voice, bytes: out.bytes } };
    },
  },

  'summarize': {
    intent: 'summarize',
    description: 'LLM-summarize a chunk of text. Args: {text: string, maxWords?: number}.',
    async run(env, args) {
      if (!env.AI) return { ok: false, error: 'AI binding missing' };
      const text = (args?.text || '').toString().slice(0, 12_000);
      if (!text) return { ok: false, error: 'text required' };
      const maxWords = clampInt(args?.maxWords, 20, 500, 120);
      const r = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
        messages: [
          { role: 'system', content: `You summarize. Output ${maxWords} words or fewer. No preamble.` },
          { role: 'user',   content: text },
        ],
      });
      const summary = (r?.response || '').trim();
      return { ok: true, result: { summary } };
    },
  },

  'finance-queue': {
    intent: 'finance-queue',
    description: 'Fetch the Accounts Payable approval queue — all pending bills and payment proposals awaiting action. No args required.',
    async run(env, _args, { userId }) {
      if (!env.GRAPH_DB) return { ok: false, error: 'GRAPH_DB binding missing' };
      const queue = await getApprovalQueue(env.GRAPH_DB, { userId });
      return { ok: true, result: queue };
    },
  },

  'list-bills': {
    intent: 'list-bills',
    description: 'List AP bills. Args: {status?: "pending"|"approved"|"paid"|"rejected"|"overdue", vendorId?: string, limit?: number}.',
    async run(env, args, { userId }) {
      if (!env.GRAPH_DB) return { ok: false, error: 'GRAPH_DB binding missing' };
      const bills = await listBills(env.GRAPH_DB, {
        userId,
        status: args?.status ? String(args.status) : undefined,
        vendorId: args?.vendorId ? String(args.vendorId) : undefined,
        limit: args?.limit,
      });
      return { ok: true, result: { bills } };
    },
  },

  'get-vendor': {
    intent: 'get-vendor',
    description: 'Look up vendors by name (partial match) or list all. Args: {name?: string, limit?: number}.',
    async run(env, args, { userId }) {
      if (!env.GRAPH_DB) return { ok: false, error: 'GRAPH_DB binding missing' };
      let vendors;
      if (args?.name) {
        // Use graph-query style label search via GRAPH_DB
        const { results } = await env.GRAPH_DB.prepare(
          `SELECT id, name, ein, payment_terms, early_pay_discount_pct, contact_email, status
           FROM apc_vendors WHERE user_id = ? AND name LIKE ? ORDER BY name LIMIT 20`
        ).bind(userId, `%${String(args.name).slice(0, 80)}%`).all();
        vendors = results || [];
      } else {
        vendors = await listVendors(env.GRAPH_DB, { userId, limit: args?.limit || 20 });
      }
      return { ok: true, result: { vendors } };
    },
  },

  'finance-summary': {
    intent: 'finance-summary',
    description: 'Summarize the current AP position: total pending/overdue amounts, upcoming tax liabilities, and queue depth. No args required.',
    async run(env, _args, { userId }) {
      if (!env.GRAPH_DB) return { ok: false, error: 'GRAPH_DB binding missing' };
      const [billsAll, taxAll] = await Promise.all([
        listBills(env.GRAPH_DB, { userId, limit: 200 }),
        listTaxLiabilities(env.GRAPH_DB, { userId, limit: 50 }),
      ]);
      const pending = billsAll.filter((b) => b.status === 'pending');
      const overdue = billsAll.filter((b) => b.status === 'overdue');
      const pendingTotal = pending.reduce((s, b) => s + (b.amountCents || 0), 0);
      const overdueTotal = overdue.reduce((s, b) => s + (b.amountCents || 0), 0);
      const taxEstimated = taxAll.filter((t) => t.status === 'estimated');
      const taxTotal = taxEstimated.reduce((s, t) => s + (t.estimatedCents || 0), 0);
      return {
        ok: true,
        result: {
          pendingBills: pending.length,
          pendingTotalCents: pendingTotal,
          overdueBills: overdue.length,
          overdueTotalCents: overdueTotal,
          taxLiabilities: taxEstimated.length,
          taxEstimatedTotalCents: taxTotal,
          summary: `${pending.length} pending bills ($${(pendingTotal / 100).toFixed(2)}), ${overdue.length} overdue ($${(overdueTotal / 100).toFixed(2)}), ${taxEstimated.length} estimated tax liabilities ($${(taxTotal / 100).toFixed(2)}).`,
        },
      };
    },
  },
};

export async function describeTools(env, { userId } = {}) {
  const builtin = Object.values(REGISTRY).map((t) => ({ intent: t.intent, description: t.description }));
  if (env && userId) {
    try {
      const mcp = await describeMcpTools(env, { userId });
      return [...builtin, ...mcp];
    } catch (err) {
      console.warn('[tools] mcp describe failed:', err.message);
    }
  }
  return builtin;
}

export async function dispatch(env, intent, args, ctx) {
  // MCP-discovered tools route through the registry → mcp-client.
  if (typeof intent === 'string' && intent.startsWith('mcp:')) {
    try {
      return await dispatchMcpTool(env, intent, args || {}, ctx || {});
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
  const tool = REGISTRY[intent];
  if (!tool) return { ok: false, error: `unknown intent: ${intent}` };
  try {
    return await tool.run(env, args || {}, ctx || {});
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── helpers ───────────────────────────────────────────────────────────

function clampInt(v, lo, hi, dflt) {
  const n = Number.isFinite(+v) ? Math.floor(+v) : dflt;
  return Math.max(lo, Math.min(hi, n));
}

function title(html) {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return m?.[1]?.trim().slice(0, 200) || null;
}

function readable(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ').trim();
}
