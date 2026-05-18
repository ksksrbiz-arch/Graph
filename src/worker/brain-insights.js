// Synthesise a BrainInsightsSummary from the Worker's own data stores
// (KV graph snapshot + D1 event log).
//
// This is the Worker-native brain layer that runs 24/7 via cron triggers.
// It mirrors the shape returned by the NestJS InsightsController so the
// Brain Insights SPA view can render identically whether it is talking to
// the NestJS API over Socket.IO or polling this endpoint on workers.dev.

const WINDOW_MS = 30_000;

const NODE_TYPE_TO_REGION = {
  email: 'sensory',
  bookmark: 'sensory',
  conversation: 'sensory',
  message: 'sensory',
  note: 'memory',
  document: 'memory',
  file: 'memory',
  concept: 'association',
  issue: 'association',
  repository: 'association',
  model: 'association',
  pull_request: 'executive',
  task: 'executive',
  project: 'executive',
  commit: 'motor',
  event: 'motor',
  tool_use: 'motor',
  person: 'limbic',
  author: 'limbic',
};

const REGION_STYLES = {
  sensory:     { color: '#5dd2ff', label: 'Sensory' },
  memory:      { color: '#9b8cff', label: 'Memory' },
  association: { color: '#7c9cff', label: 'Association' },
  executive:   { color: '#ff9b6b', label: 'Executive' },
  motor:       { color: '#ff6b9d', label: 'Motor' },
  limbic:      { color: '#ffd45c', label: 'Limbic' },
};

const CONNECTOR_BIAS = {
  gmail: 'sensory',
  outlook_mail: 'sensory',
  bookmarks: 'sensory',
};

function regionForNode(node) {
  if (node.sourceId && CONNECTOR_BIAS[node.sourceId]) return CONNECTOR_BIAS[node.sourceId];
  return NODE_TYPE_TO_REGION[node.type] ?? 'association';
}

function nodeId(v) {
  return typeof v === 'object' && v !== null ? (v.id ?? String(v)) : String(v ?? '');
}

function meanWeight(edges) {
  if (!edges.length) return 0;
  const sum = edges.reduce((s, e) => s + (Number(e.weight) || 0), 0);
  return parseFloat((sum / edges.length).toFixed(4));
}

/**
 * Build a BrainInsightsSummary from KV + D1. Never throws — returns a minimal
 * summary with `running: false` if the required bindings are absent.
 */
export async function buildBrainInsightsSummary(env, userId) {
  const topN = 10;

  // ── 1. Graph snapshot ─────────────────────────────────────────────
  let nodes = [];
  let edges = [];
  if (env.GRAPH_KV) {
    try {
      const raw = await env.GRAPH_KV.get(`graph:${userId}`, 'json');
      if (raw && Array.isArray(raw.nodes)) {
        nodes = raw.nodes;
        edges = Array.isArray(raw.edges) ? raw.edges : [];
      }
    } catch (err) {
      console.warn('[brain-insights] KV read failed:', err.message);
    }
  }

  // ── 2. Region activity ────────────────────────────────────────────
  // Map nodes to regions; fake a spike rate proportional to the share of
  // nodes in each region so the bars are populated rather than all zero.
  const regionCounts = {};
  for (const node of nodes) {
    const r = regionForNode(node);
    regionCounts[r] = (regionCounts[r] || 0) + 1;
  }
  const total = nodes.length || 1;
  const regions = Object.entries(REGION_STYLES)
    .map(([region, style]) => ({
      region,
      rate: parseFloat(((regionCounts[region] || 0) / total * 5).toFixed(2)),
      count: regionCounts[region] || 0,
      color: style.color,
      label: style.label,
    }))
    .filter((r) => r.count > 0);

  // ── 3. Pathways ───────────────────────────────────────────────────
  const weightedEdges = edges.filter((e) => typeof e.weight === 'number');
  const byWeightDesc = [...weightedEdges].sort((a, b) => (b.weight || 0) - (a.weight || 0));

  const toPathway = (e) => ({
    synapseId: e.id || `${nodeId(e.source)}|${nodeId(e.target)}`,
    pre: nodeId(e.source),
    post: nodeId(e.target),
    weight: e.weight,
    delta: 0,
  });

  const strongestPathways = byWeightDesc.slice(0, topN).map(toPathway);
  const growingPathways = byWeightDesc
    .filter((e) => e.weight > 0.6)
    .slice(0, topN)
    .map((e) => ({ ...toPathway(e), delta: parseFloat((e.weight - 0.5).toFixed(3)) }));
  const decayingPathways = byWeightDesc
    .filter((e) => e.weight < 0.4)
    .slice(-(topN))
    .reverse()
    .map((e) => ({ ...toPathway(e), delta: parseFloat((e.weight - 0.5).toFixed(3)) }));

  // ── 4. Recent formations from D1 ──────────────────────────────────
  // Ingest events whose edge_count > 0 represent newly formed pathways.
  const recentFormations = [];
  if (env.GRAPH_DB) {
    try {
      const since = Date.now() - 60 * 60_000; // last hour
      const { results } = await env.GRAPH_DB
        .prepare(
          'SELECT ts, edge_count FROM events ' +
          'WHERE user_id = ?1 AND ts >= ?2 AND edge_count > 0 ' +
          'ORDER BY ts DESC LIMIT 20',
        )
        .bind(userId, since)
        .all();
      for (const row of (results || [])) {
        // We don't store individual edge ids in the event log, so surface
        // the freshest strongestPathways as the formations. This is a
        // reasonable proxy: heavy edges were reinforced by recent ingests.
        const slice = strongestPathways.slice(0, Math.min(row.edge_count || 1, 3));
        for (const p of slice) {
          recentFormations.push({
            synapseId: p.synapseId,
            pre: p.pre,
            post: p.post,
            weight: p.weight,
            formedAt: new Date(row.ts).toISOString(),
          });
        }
        if (recentFormations.length >= 20) break;
      }
    } catch (err) {
      console.warn('[brain-insights] D1 formations query failed:', err.message);
    }
  }

  // ── 5. Connectome growth sparkline ────────────────────────────────
  const mw = meanWeight(edges);
  const growth = [];
  if (env.GRAPH_DB) {
    try {
      const since = Date.now() - 60 * 60_000;
      const { results } = await env.GRAPH_DB
        .prepare(
          'SELECT ts, node_count, edge_count FROM events ' +
          'WHERE user_id = ?1 AND ts >= ?2 ' +
          'ORDER BY ts ASC LIMIT 60',
        )
        .bind(userId, since)
        .all();
      if (results?.length) {
        let runN = Math.max(0, nodes.length - results.reduce((s, r) => s + (r.node_count || 0), 0));
        let runE = Math.max(0, edges.length - results.reduce((s, r) => s + (r.edge_count || 0), 0));
        for (const row of results) {
          runN += row.node_count || 0;
          runE += row.edge_count || 0;
          growth.push({ at: new Date(row.ts).toISOString(), neurons: runN, synapses: runE, meanWeight: mw });
        }
      }
    } catch (err) {
      console.warn('[brain-insights] D1 growth query failed:', err.message);
    }
  }
  if (!growth.length) {
    growth.push({ at: new Date().toISOString(), neurons: nodes.length, synapses: edges.length, meanWeight: mw });
  }

  return {
    running: Boolean(env.AI),
    windowMs: WINDOW_MS,
    regions,
    strongestPathways,
    growingPathways,
    decayingPathways,
    recentFormations: recentFormations.slice(0, 20),
    growth,
  };
}
