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
   * Future: Support incremental updates (delta from /graph/delta)
   */
  applyDelta(currentGraph, delta) {
    // TODO: Implement smart merge for live updates
    console.log('[DataBridge] Delta application not yet implemented');
    return this.normalizeGraph(currentGraph);
  }
}
