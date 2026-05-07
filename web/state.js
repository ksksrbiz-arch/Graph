import { srcId, tgtId } from './util.js';

const listeners = new Set();

export const state = {
  graph: { nodes: [], edges: [], metadata: {} },
  byId: new Map(),
  adjacency: new Map(),
  /** sourceId -> array of outgoing edge objects (used by the spike renderer). */
  outgoing: new Map(),
  filters: {
    types: new Set(),
    minEdgeWeight: 0,
    search: '',
  },
  selectedId: null,
  hoveredId: null,
  focusRootId: null,
  focusDepth: 2,
  pendingFocus: null,
  config: {
    // dimensions: 2 = classic flat, 3 = volumetric, 4 = 3D + temporal axis
    dimensions: 2,
    // d3-force tunings
    chargeStrength: -120,
    linkDistance: 60,
    linkStrength: 0.5,
    gravity: 0.05,
    collisionRadius: 0,
    velocityDecay: 0.4,
    alphaDecay: 0.0228,
    cooldownTicks: Infinity,
    // visuals
    nodeRelSize: 4,
    nodeOpacity: 1,
    edgeOpacity: 0.35,
    edgeCurvature: 0,
    edgeWidthScale: 1.6,
    showLabels: false,
    bloom: true,
    bgIntensity: 0.6,
    colorMode: 'type',     // 'type' | 'region' | 'degree'
    // neural-link
    spikes: true,
    spikeIntensity: 1,
    pulseSpeed: 1,
    linkParticles: 1,
    regionClustering: 0.0,  // 0..1 strength of same-region attraction
    // 4D temporal axis
    temporalField: 'createdAt',
    temporalScale: 1,
    // misc
    autoRefresh: false,
  },
  loading: false,
};

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit(reason = 'change', payload = {}) {
  for (const fn of listeners) fn(reason, payload);
}

export function setGraph(graph) {
  state.graph = graph;
  state.byId = new Map(graph.nodes.map((n) => [n.id, n]));
  state.adjacency = buildAdjacency(graph.edges);
  state.outgoing = buildOutgoing(graph.edges);
  for (const n of graph.nodes) {
    n.__degree = (state.adjacency.get(n.id)?.size) || 0;
  }
  if (state.filters.types.size === 0) {
    state.filters.types = new Set(graph.nodes.map((n) => n.type));
  } else {
    const present = new Set(graph.nodes.map((n) => n.type));
    for (const t of [...state.filters.types]) if (!present.has(t)) state.filters.types.delete(t);
    // If all previously-selected types were removed, default to showing every
    // type in the new graph.  The original code only added the first new type
    // because it re-evaluated `state.filters.types.length` inside the loop —
    // fixed here by capturing the "was empty" flag before the loop starts.
    if (state.filters.types.size === 0) {
      for (const t of present) state.filters.types.add(t);
    }
  }
  emit('graph-loaded');
}

function buildAdjacency(edges) {
  const adj = new Map();
  for (const e of edges) {
    const s = srcId(e), t = tgtId(e);
    if (!adj.has(s)) adj.set(s, new Set());
    if (!adj.has(t)) adj.set(t, new Set());
    adj.get(s).add(t);
    adj.get(t).add(s);
  }
  return adj;
}

function buildOutgoing(edges) {
  const out = new Map();
  for (const e of edges) {
    const s = srcId(e);
    if (!out.has(s)) out.set(s, []);
    out.get(s).push(e);
  }
  return out;
}

export function neighborsWithin(rootId, depth) {
  const visited = new Set([rootId]);
  let frontier = new Set([rootId]);
  for (let d = 0; d < depth; d++) {
    const next = new Set();
    for (const id of frontier) {
      for (const nb of state.adjacency.get(id) || []) {
        if (!visited.has(nb)) {
          visited.add(nb); next.add(nb);
        }
      }
    }
    frontier = next;
  }
  return visited;
}

export function visibleNodeIds() {
  const { types, search } = state.filters;
  const q = search.trim().toLowerCase();
  let allowed = state.graph.nodes
    .filter((n) => types.has(n.type))
    .filter((n) => !q || matchesQuery(n, q))
    .map((n) => n.id);
  if (state.focusRootId && state.byId.has(state.focusRootId)) {
    const ego = neighborsWithin(state.focusRootId, state.focusDepth);
    allowed = allowed.filter((id) => ego.has(id));
  }
  return new Set(allowed);
}

export function matchesQuery(node, q) {
  if ((node.label || '').toLowerCase().includes(q)) return true;
  if ((node.id || '').toLowerCase().includes(q)) return true;
  if ((node.type || '').toLowerCase().includes(q)) return true;
  for (const v of Object.values(node.metadata || {})) {
    if (v == null) continue;
    if (typeof v === 'string' && v.toLowerCase().includes(q)) return true;
    if (typeof v === 'number' && String(v).includes(q)) return true;
  }
  return false;
}

export function setFilterTypes(types) {
  state.filters.types = new Set(types);
  emit('filters-changed');
}

export function toggleFilterType(type, on) {
  if (on) state.filters.types.add(type);
  else state.filters.types.delete(type);
  emit('filters-changed');
}

export function setSearch(q) {
  state.filters.search = q;
  emit('search-changed');
}

export function setMinEdgeWeight(w) {
  state.filters.minEdgeWeight = w;
  emit('filters-changed');
}

export function setSelected(id) {
  state.selectedId = id;
  emit('selection-changed');
}

export function setFocusRoot(id) {
  state.focusRootId = id;
  emit('focus-changed');
}

export function setHovered(id) {
  state.hoveredId = id;
  emit('hover-changed');
}

export function setConfig(patch) {
  Object.assign(state.config, patch);
  emit('config-changed', patch);
}

export function setDimensions(d) {
  const next = d === 3 || d === 4 ? d : 2;
  if (state.config.dimensions === next) return;
  state.config.dimensions = next;
  emit('dimensions-changed', { dimensions: next });
}

export function setPendingFocus(id) {
  state.pendingFocus = id;
}
