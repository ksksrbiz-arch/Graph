// Semantic recall layer — wraps Workers AI BGE embeddings + Vectorize index.
// Stored vector id = `${userId}:${nodeId}` so multi-tenant search is a hard
// filter, not a soft hint. Metadata mirrors the node row so the reasoner can
// render results without a second D1 lookup.
//
// All functions tolerate missing bindings (returns []) so the cortex still
// works when env.VECTORS or env.AI isn't wired locally.

const EMBED_MODEL = '@cf/baai/bge-base-en-v1.5';
const EMBED_BATCH = 96;        // Workers AI cap per request for BGE
const UPSERT_BATCH = 200;      // Vectorize cap per upsert
const QUERY_TOPK_DEFAULT = 6;

/** SHA-derived stable id (string) so a node id like a UUID is preserved
 *  in the vector index. We pass through unchanged but namespace by user. */
const vectorId = (userId, nodeId) => `${userId}:${nodeId}`;

/** Build the text we embed for a node — label dominates, type adds the
 *  semantic shape ("a `bookmark` called …"), metadata.excerpt etc. fold in. */
function nodeToText(n) {
  const parts = [];
  if (n.type)  parts.push(`(${n.type})`);
  if (n.label) parts.push(n.label);
  const md = n.metadata || n.data || {};
  if (md.excerpt)  parts.push(md.excerpt);
  if (md.heading)  parts.push(md.heading);
  if (md.summary)  parts.push(md.summary);
  if (md.tag)      parts.push(`#${md.tag}`);
  if (md.url)      parts.push(md.url);
  return parts.join(' — ').slice(0, 1024);
}

/** Embed N strings in one or more BGE calls. Returns a Float32 vectors[][]. */
export async function embedTexts(env, texts) {
  if (!env.AI || !texts?.length) return [];
  const out = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const chunk = texts.slice(i, i + EMBED_BATCH);
    const resp = await env.AI.run(EMBED_MODEL, { text: chunk });
    // Workers AI returns { data: number[][] } for the BGE family.
    if (resp?.data) out.push(...resp.data);
  }
  return out;
}

/**
 * Best-effort upsert of nodes into Vectorize. Embeds + uploads in batches.
 * Returns the count successfully written. Errors are swallowed so a flaky
 * AI call never breaks an ingest write.
 */
export async function upsertNodes(env, userId, nodes) {
  if (!env.VECTORS || !env.AI || !nodes?.length) return 0;
  const cleaned = nodes.filter((n) => n?.id && (n.label || n.metadata || n.data));
  if (!cleaned.length) return 0;

  let written = 0;
  for (let i = 0; i < cleaned.length; i += EMBED_BATCH) {
    const chunk = cleaned.slice(i, i + EMBED_BATCH);
    let vectors;
    try {
      vectors = await embedTexts(env, chunk.map(nodeToText));
    } catch (err) {
      console.warn('[vector] embed failed:', err.message);
      continue;
    }
    if (vectors.length !== chunk.length) {
      console.warn(`[vector] embed shape mismatch: got ${vectors.length} for ${chunk.length}`);
      continue;
    }
    const items = chunk.map((n, j) => ({
      id: vectorId(userId, n.id),
      values: vectors[j],
      metadata: {
        userId,
        nodeId: n.id,
        type:  String(n.type || 'note').slice(0, 60),
        label: String(n.label || '').slice(0, 240),
        sourceKind: String(n.sourceId || n.sourceKind || ''),
        ts: Date.now(),
      },
    }));
    for (let k = 0; k < items.length; k += UPSERT_BATCH) {
      try {
        await env.VECTORS.upsert(items.slice(k, k + UPSERT_BATCH));
        written += Math.min(UPSERT_BATCH, items.length - k);
      } catch (err) {
        console.warn('[vector] upsert failed:', err.message);
      }
    }
  }
  return written;
}

/**
 * Top-k semantic recall for a free-text query. Returns matches narrowed to
 * the given userId via metadata filter (Vectorize V2 supports inline
 * filtering on metadata fields).
 */
export async function recall(env, userId, query, opts = {}) {
  if (!env.VECTORS || !env.AI || !query) return { ok: false, error: 'vectorize/AI binding missing or empty query', matches: [] };
  const k = clampInt(opts.topK, 1, 50, QUERY_TOPK_DEFAULT);
  let qv;
  try {
    const resp = await env.AI.run(EMBED_MODEL, { text: [query] });
    qv = resp?.data?.[0];
  } catch (err) {
    return { ok: false, error: `embed failed: ${err.message}`, matches: [] };
  }
  if (!qv) return { ok: false, error: 'empty embedding', matches: [] };

  let res;
  try {
    // Try the filtered path first (works once the metadata index settles).
    res = await env.VECTORS.query(qv, {
      topK: k,
      returnMetadata: 'all',
      filter: { userId },
    });
  } catch (err) {
    console.warn('[vector] filtered query failed, retrying unfiltered:', err.message);
    try {
      res = await env.VECTORS.query(qv, { topK: k, returnMetadata: 'all' });
    } catch (err2) {
      return { ok: false, error: `query failed: ${err2.message}`, matches: [] };
    }
  }
  // Defense-in-depth: even if the filter silently returned everyone, narrow
  // down by metadata.userId here so cross-tenant leaks can't happen.
  const matches = (res?.matches || [])
    .filter((m) => !m.metadata?.userId || m.metadata.userId === userId)
    .map((m) => ({
      score: m.score,
      nodeId: m.metadata?.nodeId,
      type:   m.metadata?.type,
      label:  m.metadata?.label,
      sourceKind: m.metadata?.sourceKind,
    }));
  // If the filtered server-side query returned 0 (metadata index not yet
  // built) but unfiltered would find matches, retry unfiltered explicitly.
  if (matches.length === 0 && (res?.matches || []).length === 0) {
    try {
      const fallback = await env.VECTORS.query(qv, { topK: k, returnMetadata: 'all' });
      const more = (fallback?.matches || [])
        .filter((m) => !m.metadata?.userId || m.metadata.userId === userId)
        .map((m) => ({
          score: m.score,
          nodeId: m.metadata?.nodeId,
          type:   m.metadata?.type,
          label:  m.metadata?.label,
          sourceKind: m.metadata?.sourceKind,
        }));
      if (more.length) return { ok: true, matches: more, fallback: 'unfiltered' };
    } catch {}
  }
  return { ok: true, matches };
}

/** Drop all vectors for a user — used by admin reset. Returns deleted count. */
export async function deleteForUser(env, userId, ids) {
  if (!env.VECTORS || !ids?.length) return 0;
  const targets = ids.map((id) => vectorId(userId, id));
  let removed = 0;
  for (let i = 0; i < targets.length; i += UPSERT_BATCH) {
    try {
      await env.VECTORS.deleteByIds(targets.slice(i, i + UPSERT_BATCH));
      removed += Math.min(UPSERT_BATCH, targets.length - i);
    } catch (err) {
      console.warn('[vector] delete failed:', err.message);
    }
  }
  return removed;
}

function clampInt(v, lo, hi, dflt) {
  const n = Number.isFinite(+v) ? Math.floor(+v) : dflt;
  return Math.max(lo, Math.min(hi, n));
}
