/**
 * DataBridge v2
 *
 * Responsible for ingesting data from the existing graph ecosystem
 * (web/data.js, public ingest, state.js, etc.) and transforming it
 * into the clean format expected by the new UI v2 architecture.
 *
 * This is the critical bridge that will eventually allow the new UI
 * to replace the old one without losing any data sources.
 */

export class DataBridge {
  constructor() {}

  /**
   * Normalize a graph from the project's common format.
   * Supports both the old web/state format and the public ingest format.
   */
  normalizeGraph(input) {
    if (!input) return { nodes: [], edges: [] };

    // Case 1: { nodes: [], edges: [] } (most common)
    if (Array.isArray(input.nodes) && Array.isArray(input.edges)) {
      return {
        nodes: input.nodes.map(this._normalizeNode),
        edges: input.edges.map(this._normalizeEdge),
      };
    }

    // Case 2: old state shape { graph: { nodes, edges } }
    if (input.graph && Array.isArray(input.graph.nodes)) {
      return this.normalizeGraph(input.graph);
    }

    // Case 3: raw array of nodes (rare)
    if (Array.isArray(input)) {
      return {
        nodes: input.map(this._normalizeNode),
        edges: [],
      };
    }

    console.warn('[DataBridge] Unknown graph format, returning empty graph');
    return { nodes: [], edges: [] };
  }

  _normalizeNode(n) {
    if (!n) return null;
    return {
      id: n.id || n._id || String(Math.random()),
      label: n.label || n.title || n.name || n.id,
      type: n.type || n.nodeType || 'unknown',
      sourceId: n.sourceId || n.source || 'unknown',
      createdAt: n.createdAt || n.timestamp || new Date().toISOString(),
      metadata: n.metadata || {},
      // Preserve any extra fields the old system might rely on
      ...n,
      // Mark as v1 data for future migration logic
      __v1: true,
    };
  }

  _normalizeEdge(e) {
    if (!e) return null;
    return {
      id: e.id || `${e.source}-${e.target}-${Math.random()}`,
      source: e.source || e.from,
      target: e.target || e.to,
      relation: e.relation || e.type || 'RELATED_TO',
      weight: typeof e.weight === 'number' ? e.weight : 0.5,
      metadata: e.metadata || {},
      ...e,
      __v1: true,
    };
  }

  /**
   * Apply an incremental update (delta from /graph/delta) on top of the
   * current dataset.
   *
   * Smart merge semantics:
   * - New nodes/edges (by id) are added; existing ones are updated in place.
   * - No duplicates: ids are deduped via Maps.
   * - Node positions (and other live runtime fields) from the existing dataset
   *   are preserved when an incoming node doesn't carry its own position.
   *
   * `target` is the StateManager. We mirror the full-load path exactly: just as
   * GraphView.setGraph() normalizes then calls `state.setGraph(normalized)`,
   * here we merge, normalize, then call `state.setGraph(merged)` so the rest of
   * the UI reacts identically.
   *
   * Returns the merged `{ nodes, edges }` (arrays) for convenience.
   */
  applyDelta(target, delta) {
    const normalizedDelta = this.normalizeGraph(delta);

    // Read the current dataset out of the state layer (nodes/edges are Maps).
    const current = target && typeof target.get === 'function' ? target.get() : null;
    const currentNodes = current && current.nodes instanceof Map ? current.nodes : new Map();
    const currentEdges = current && current.edges instanceof Map ? current.edges : new Map();

    // Position / runtime fields written by the force-graph renderer that must
    // survive a delta so nodes don't visually jump.
    const POSITION_FIELDS = ['x', 'y', 'z', 'vx', 'vy', 'vz', 'fx', 'fy', 'fz'];

    // --- Merge nodes (upsert by id) ---
    const nodeMap = new Map(currentNodes);
    for (const node of normalizedDelta.nodes) {
      if (!node || node.id == null) continue;
      const existing = nodeMap.get(node.id);
      if (existing) {
        const merged = { ...existing, ...node };
        // Preserve existing positions unless the incoming node provides its own.
        for (const f of POSITION_FIELDS) {
          if (node[f] === undefined && existing[f] !== undefined) {
            merged[f] = existing[f];
          }
        }
        nodeMap.set(node.id, merged);
      } else {
        nodeMap.set(node.id, node);
      }
    }

    // --- Merge edges (upsert by structural identity) ---
    // Note: _normalizeEdge assigns a RANDOM id to any edge that arrives without
    // an explicit one, so an edge's `id` is not stable across delta batches.
    // Key on source/target/relation instead so re-sending the same edge upserts
    // rather than duplicating. Existing edges (already normalized with a stable
    // id) are keyed the same way to find their match.
    const edgeKey = (e) => `${e.source}->${e.target}::${e.relation || 'RELATED_TO'}`;
    const edgeMap = new Map();
    for (const edge of currentEdges.values()) {
      if (edge) edgeMap.set(edgeKey(edge), edge);
    }
    for (const edge of normalizedDelta.edges) {
      if (!edge) continue;
      const key = edgeKey(edge);
      const existing = edgeMap.get(key);
      // Keep the existing edge's id stable across delta batches (the incoming
      // id may be a freshly-generated random one from _normalizeEdge).
      edgeMap.set(key, existing ? { ...existing, ...edge, id: existing.id } : edge);
    }

    const merged = {
      nodes: Array.from(nodeMap.values()),
      edges: Array.from(edgeMap.values()),
    };

    // Notify the state layer the same way the initial load does.
    if (target && typeof target.setGraph === 'function') {
      target.setGraph(merged);
    } else {
      console.warn('[DataBridge] applyDelta called without a StateManager; returning merged graph only');
    }

    return merged;
  }
}
