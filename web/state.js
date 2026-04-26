import { srcId, tgtId } from './util.js';

const listeners = new Set();

export const state = {
  graph: { nodes: [], edges: [], metadata: {} },
  byId: new Map(),
  adjacency: new Map(),
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
    chargeStrength: -120,
    linkDistance: 60,
    nodeRelSize: 4,
    showLabels: false,
    particles: false,
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
  for (const n of graph.nodes) {
    n.__degree = (state.adjacency.get(n.id)?.size) || 0;
  }
  if (state.filters.types.size === 0) {
    state.filters.types = new Set(graph.nodes.map((n) => n.type));
  } else {
    const present = new Set(graph.nodes.map((n) => n.type));
    for (const t of [...state.filters.types]) if (!present.has(t)) state.filters.types.delete(t);
    for (const t of present) if (![...state.filters.types].length) state.filters.types.add(t);
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

export function setPendingFocus(id) {
  state.pendingFocus = id;
}
