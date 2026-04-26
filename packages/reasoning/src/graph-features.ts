// Lightweight graph data shapes used by the reasoning algorithms. They are
// intentionally narrower than KGNode/KGEdge so the reasoning package stays a
// pure-data citizen — the API layer adapts Neo4j records into these types
// before invoking the algorithms.

export interface ReasoningNode {
  id: string;
  /** Optional label — surfaced in explanations from `reasoningPath`. */
  label?: string;
  /** Optional type — used as a feature for classification. */
  type?: string;
}

export interface ReasoningEdge {
  source: string;
  target: string;
  /** Strength in [0, 1]; defaults to 0.5 if absent. Treated as undirected. */
  weight?: number;
  /** Optional relation tag — preserved in path explanations. */
  relation?: string;
}

export interface ReasoningGraph {
  nodes: ReasoningNode[];
  edges: ReasoningEdge[];
}

/** O(V + E) precomputation of an undirected adjacency map. Each entry stores
 *  the *neighbour* node id and the edge that joined them, so callers can
 *  recover edge weight + relation cheaply during traversal. */
export interface Adjacency {
  /** id → list of (neighbourId, edge). */
  neighbours: Map<string, Array<{ id: string; edge: ReasoningEdge }>>;
  /** id → ReasoningNode (for label/type lookup). */
  nodes: Map<string, ReasoningNode>;
}

export function buildAdjacency(graph: ReasoningGraph): Adjacency {
  const neighbours = new Map<string, Array<{ id: string; edge: ReasoningEdge }>>();
  const nodes = new Map<string, ReasoningNode>();
  for (const n of graph.nodes) nodes.set(n.id, n);
  const ensure = (id: string) => {
    let arr = neighbours.get(id);
    if (!arr) {
      arr = [];
      neighbours.set(id, arr);
    }
    return arr;
  };
  for (const e of graph.edges) {
    if (e.source === e.target) continue; // self-loops contribute no information
    ensure(e.source).push({ id: e.target, edge: e });
    ensure(e.target).push({ id: e.source, edge: e });
  }
  return { neighbours, nodes };
}

/** Set of unique neighbour ids for `nodeId`. */
export function neighbourSet(adj: Adjacency, nodeId: string): Set<string> {
  const out = new Set<string>();
  const arr = adj.neighbours.get(nodeId);
  if (!arr) return out;
  for (const { id } of arr) out.add(id);
  return out;
}

/** Degree count (size of unique neighbour set). */
export function degree(adj: Adjacency, nodeId: string): number {
  return neighbourSet(adj, nodeId).size;
}
