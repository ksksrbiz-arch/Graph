// D1-backed event log + flat node/edge projection + ingest source registry.
//
// Lives alongside the KV snapshot (src/worker.js → mergeAndPersist). KV holds
// the rendered graph that the SPA paints on first load (one O(1) read per
// page); D1 holds the structured log that lets us answer:
//
//   • "what did Stripe push in the last week"
//   • "which sources are registered, when did each last fire"
//   • "show me the raw payload for event X so I can replay it"
//
// All functions are pure with respect to their `db` argument — no module
// state, safe to call concurrently from a Worker. Callers should `await`
// each batch they want serialized.

const TEXT_MAX = 1_000_000; // hard cap on a single payload_json blob (D1 row)

/**
 * Append an ingest event. Idempotent on (user_id, payload_sha) — a duplicate
 * payload re-applied within ~30 days returns the existing row instead of
 * inserting a new one. Returns the row id.
 */
export async function recordEvent(db, evt) {
  if (!db) return null;
  const id = crypto.randomUUID();
  const ts = Date.now();
  const payloadJson = trimJson(evt.payload);
  const payloadSha = await sha256Hex(payloadJson);

  // Try to insert; if a duplicate sha exists for this user, return the prior
  // row's id so callers can correlate without retry storms.
  try {
    const stmt = db.prepare(
      `INSERT INTO events
        (id, ts, user_id, source_id, source_kind, kind, payload_sha,
         payload_json, node_count, edge_count, status, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    await stmt
      .bind(
        id,
        ts,
        evt.userId,
        evt.sourceId ?? null,
        evt.sourceKind,
        evt.kind,
        payloadSha,
        payloadJson,
        evt.nodeCount | 0,
        evt.edgeCount | 0,
        evt.status ?? 'applied',
        evt.error ?? null,
      )
      .run();
    return { id, ts, deduped: false };
  } catch (err) {
    // SQLITE_CONSTRAINT — duplicate hash. Look up the prior id.
    const prior = await db
      .prepare(`SELECT id, ts FROM events WHERE user_id = ? AND payload_sha = ? LIMIT 1`)
      .bind(evt.userId, payloadSha)
      .first();
    if (prior) return { id: prior.id, ts: prior.ts, deduped: true };
    throw err;
  }
}

export async function listEvents(db, { userId, since, sourceKind, limit }) {
  if (!db) return [];
  const safeLimit = Math.max(1, Math.min(500, limit | 0 || 50));
  const filters = ['user_id = ?'];
  const params = [userId];
  if (since) {
    filters.push('ts >= ?');
    params.push(Number(since));
  }
  if (sourceKind) {
    filters.push('source_kind = ?');
    params.push(sourceKind);
  }
  const sql = `SELECT id, ts, source_id, source_kind, kind,
                      node_count, edge_count, status, error
               FROM events
               WHERE ${filters.join(' AND ')}
               ORDER BY ts DESC
               LIMIT ${safeLimit}`;
  const { results } = await db
    .prepare(sql)
    .bind(...params)
    .all();
  return results || [];
}

export async function getEventPayload(db, { userId, eventId }) {
  if (!db) return null;
  return db
    .prepare(`SELECT payload_json FROM events WHERE user_id = ? AND id = ? LIMIT 1`)
    .bind(userId, eventId)
    .first();
}

/**
 * Upsert nodes + edges into the flat projection. This is fire-and-forget
 * relative to KV — KV is still the source of truth for rendering. D1 is the
 * source of truth for SQL queries ("show me all nodes of type=bookmark").
 */
export async function upsertNodesAndEdges(db, { userId, sourceKind, nodes, edges }) {
  if (!db || (!nodes?.length && !edges?.length)) return { nodes: 0, edges: 0 };
  const ts = Date.now();
  const stmts = [];

  for (const n of nodes ?? []) {
    if (!n?.id) continue;
    stmts.push(
      db
        .prepare(
          `INSERT INTO nodes
             (id, user_id, type, label, data_json, source_kind, first_seen_at, last_seen_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
           ON CONFLICT (user_id, id) DO UPDATE SET
             type = excluded.type,
             label = excluded.label,
             data_json = excluded.data_json,
             source_kind = COALESCE(excluded.source_kind, nodes.source_kind),
             last_seen_at = excluded.last_seen_at`,
        )
        .bind(
          n.id,
          userId,
          n.type ?? 'note',
          (n.label ?? '').toString().slice(0, 500),
          JSON.stringify(n.metadata ?? n.data ?? {}),
          sourceKind ?? n.sourceId ?? null,
          ts,
        ),
    );
  }

  for (const e of edges ?? []) {
    if (!e?.id || !(e.source ?? e.pre) || !(e.target ?? e.post)) continue;
    stmts.push(
      db
        .prepare(
          `INSERT INTO edges
             (id, user_id, pre, post, type, weight, source_kind, first_seen_at, last_seen_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
           ON CONFLICT (user_id, id) DO UPDATE SET
             type = excluded.type,
             weight = (edges.weight + excluded.weight) / 2,
             source_kind = COALESCE(excluded.source_kind, edges.source_kind),
             last_seen_at = excluded.last_seen_at`,
        )
        .bind(
          e.id,
          userId,
          e.source ?? e.pre,
          e.target ?? e.post,
          e.relation ?? e.type ?? 'LINKS_TO',
          Number.isFinite(e.weight) ? Number(e.weight) : 0.5,
          sourceKind ?? null,
          ts,
        ),
    );
  }

  if (stmts.length === 0) return { nodes: 0, edges: 0 };
  await db.batch(stmts);
  return { nodes: nodes?.length ?? 0, edges: edges?.length ?? 0 };
}

// ── sources / webhooks ────────────────────────────────────────────────

export async function registerSource(db, { userId, kind, label, config }) {
  if (!db) throw new Error('GRAPH_DB binding missing');
  const id = crypto.randomUUID();
  const secret = await randomToken(32);
  await db
    .prepare(
      `INSERT INTO sources (id, user_id, kind, label, config_json, webhook_secret, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, userId, kind, label, JSON.stringify(config ?? {}), secret, Date.now())
    .run();
  return { id, secret };
}

export async function listSources(db, { userId }) {
  if (!db) return [];
  const { results } = await db
    .prepare(
      `SELECT id, kind, label, created_at, last_seen_at
       FROM sources WHERE user_id = ? ORDER BY created_at DESC`,
    )
    .bind(userId)
    .all();
  return results || [];
}

export async function getSource(db, { sourceId }) {
  if (!db) return null;
  return db
    .prepare(
      `SELECT id, user_id, kind, label, config_json, webhook_secret
       FROM sources WHERE id = ? LIMIT 1`,
    )
    .bind(sourceId)
    .first();
}

export async function touchSource(db, { sourceId }) {
  if (!db || !sourceId) return;
  await db
    .prepare(`UPDATE sources SET last_seen_at = ? WHERE id = ?`)
    .bind(Date.now(), sourceId)
    .run();
}

/**
 * Verify an HMAC-SHA256 signature on a webhook payload. Compares in
 * constant time. Returns true when sig matches `hex(hmac(secret, body))`.
 */
export async function verifyWebhookSig(secret, body, sigHex) {
  if (!secret || !sigHex) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const expected = [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return constantTimeEqual(expected, sigHex.toLowerCase());
}

// ── stats ─────────────────────────────────────────────────────────────

export async function statsByKind(db, { userId }) {
  if (!db) return { nodes: [], edges: [], events: [] };
  const [nodes, edges, events] = await Promise.all([
    db
      .prepare(`SELECT type, COUNT(*) AS n FROM nodes WHERE user_id = ? GROUP BY type ORDER BY n DESC`)
      .bind(userId)
      .all(),
    db
      .prepare(`SELECT type, COUNT(*) AS n FROM edges WHERE user_id = ? GROUP BY type ORDER BY n DESC`)
      .bind(userId)
      .all(),
    db
      .prepare(
        `SELECT source_kind, COUNT(*) AS n, MAX(ts) AS last_ts
         FROM events WHERE user_id = ? GROUP BY source_kind ORDER BY last_ts DESC`,
      )
      .bind(userId)
      .all(),
  ]);
  return {
    nodes: nodes.results || [],
    edges: edges.results || [],
    events: events.results || [],
  };
}

// ── helpers ───────────────────────────────────────────────────────────

function trimJson(value) {
  const s = JSON.stringify(value ?? {});
  if (s.length <= TEXT_MAX) return s;
  return JSON.stringify({
    __truncated: true,
    head: s.slice(0, TEXT_MAX - 256),
    originalLength: s.length,
  });
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function randomToken(byteLen) {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
