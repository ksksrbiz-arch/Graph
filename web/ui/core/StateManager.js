/**
 * StateManager — Clean, observable state for the new Graph UI v2.
 *
 * Design:
 * - Single source of truth
 * - Immutable updates where practical (shallow for performance)
 * - Fine-grained subscriptions
 * - No magic, easy to debug
 */

export class StateManager {
  constructor(initialState = {}) {
    this.state = {
      // Graph data
      nodes: new Map(),           // id -> node
      edges: new Map(),           // id -> edge
      adjacency: new Map(),       // nodeId -> Set of neighbor ids

      // UI State
      selectedId: null,
      hoveredId: null,
      focusRootId: null,
      focusDepth: 2,

      // Filters & View
      filters: {
        types: new Set(),
        minEdgeWeight: 0,
        search: '',
      },

      // Configuration
      config: {
        dimensions: 2,
        nodeRelSize: 4,
        nodeOpacity: 1,
        edgeOpacity: 0.4,
        edgeWidthScale: 1.6,
        showLabels: false,
        bloom: true,
        spikes: true,
        regionClustering: 0.0,
        colorMode: 'type', // 'type' | 'region' | 'degree' | 'source'
        ...initialState.config,
      },

      // Runtime
      loading: false,
      error: null,
      ...initialState,
    };

    this.listeners = new Map(); // key -> Set<fn>
    this._globalListeners = new Set();
  }

  get() {
    return this.state;
  }

  /**
   * Subscribe to a specific slice of state or to all changes.
   * Returns an unsubscribe function.
   */
  subscribe(keyOrFn, fn) {
    if (typeof keyOrFn === 'function') {
      // Global listener
      this._globalListeners.add(keyOrFn);
      keyOrFn(this.state);
      return () => this._globalListeners.delete(keyOrFn);
    }

    if (!this.listeners.has(keyOrFn)) {
      this.listeners.set(keyOrFn, new Set());
    }
    this.listeners.get(keyOrFn).add(fn);

    // Initial call
    fn(this._getSlice(keyOrFn));

    return () => {
      const set = this.listeners.get(keyOrFn);
      if (set) set.delete(fn);
    };
  }

  /**
   * Update state immutably (shallow) and notify listeners.
   */
  update(updater) {
    const prev = this.state;
    const next = typeof updater === 'function' ? updater(prev) : { ...prev, ...updater };

    // Shallow equality check for performance
    if (next === prev) return;

    this.state = next;

    // Notify specific listeners
    for (const [key, fns] of this.listeners) {
      const prevSlice = this._getSlice(key, prev);
      const nextSlice = this._getSlice(key, next);

      if (prevSlice !== nextSlice) {
        for (const fn of fns) {
          try { fn(nextSlice); } catch (e) { console.error(e); }
        }
      }
    }

    // Notify global listeners
    for (const fn of this._globalListeners) {
      try { fn(next); } catch (e) { console.error(e); }
    }
  }

  // Convenience setters
  setGraph({ nodes = [], edges = [] }) {
    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    const edgeMap = new Map(edges.map(e => [e.id || `${e.source}-${e.target}`, e]));

    const adjacency = new Map();
    for (const e of edges) {
      if (!adjacency.has(e.source)) adjacency.set(e.source, new Set());
      if (!adjacency.has(e.target)) adjacency.set(e.target, new Set());
      adjacency.get(e.source).add(e.target);
      adjacency.get(e.target).add(e.source);
    }

    this.update({
      nodes: nodeMap,
      edges: edgeMap,
      adjacency,
    });
  }

  selectNode(id) {
    this.update({ selectedId: id });
  }

  hoverNode(id) {
    this.update({ hoveredId: id });
  }

  setConfig(partial) {
    this.update(s => ({
      config: { ...s.config, ...partial }
    }));
  }

  _getSlice(key, state = this.state) {
    if (key in state) return state[key];
    return undefined;
  }
}
