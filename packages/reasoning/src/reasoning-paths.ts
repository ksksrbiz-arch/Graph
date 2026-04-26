// Multi-hop reasoning over the knowledge graph. Given two nodes, find the
// strongest connecting path — the route whose edge weights multiplied
// together give the highest score. Implemented as Dijkstra on the cost metric
// `cost = -log(weight)`, which converts "maximise product of weights" into a
// "minimise sum of costs" shortest-path.
//
// Returned paths include both the visited nodes and the edges between them, so
// the API surface can render a human-readable explanation ("A is related to B
// because A → REPLIED_TO → C → AUTHORED_BY → B").

import {
  buildAdjacency,
  type ReasoningEdge,
  type ReasoningGraph,
  type ReasoningNode,
} from './graph-features.js';

export interface ReasoningStep {
  from: string;
  to: string;
  edge: ReasoningEdge;
  /** Effective weight in [0, 1] used for scoring this hop. */
  weight: number;
}

export interface ReasoningPath {
  source: string;
  target: string;
  /** Ordered list of node ids visited, including source and target. */
  nodes: ReasoningNode[];
  /** Hop-by-hop edges, length = nodes.length - 1. */
  steps: ReasoningStep[];
  /** Product of edge weights — the strength of the explanation in [0, 1]. */
  strength: number;
  /** Number of hops. */
  length: number;
}

export interface ReasoningPathOptions {
  /** Maximum hops to consider. Default 4. */
  maxDepth?: number;
  /** Floor on edge weight; weights below this are clamped up so isolated
   *  weak links don't blow up the -log cost. Default 0.05. */
  minEdgeWeight?: number;
}

/**
 * Find the highest-strength path from `sourceId` to `targetId` via Dijkstra
 * on `cost = -log(weight)`. Returns null if the target is unreachable within
 * `maxDepth` hops.
 *
 * Treats the graph as undirected — directionality of KG edges is rarely
 * meaningful for reasoning queries (a → REPLIED_TO → b implies b participated
 * in the same conversation as a regardless of direction).
 */
export function findReasoningPath(
  graph: ReasoningGraph,
  sourceId: string,
  targetId: string,
  opts: ReasoningPathOptions = {},
): ReasoningPath | null {
  if (sourceId === targetId) return null;
  const maxDepth = opts.maxDepth ?? 4;
  const minWeight = Math.max(1e-6, opts.minEdgeWeight ?? 0.05);
  const adj = buildAdjacency(graph);
  if (!adj.nodes.has(sourceId) || !adj.nodes.has(targetId)) return null;

  // Dijkstra with depth cap. The frontier is small (knowledge graphs are
  // sparse), so a sorted-array priority queue is plenty.
  interface State {
    id: string;
    cost: number;
    depth: number;
    prev: string | null;
    edge: ReasoningEdge | null;
    weight: number;
  }
  const best = new Map<string, number>([[sourceId, 0]]);
  const prev = new Map<string, { id: string; edge: ReasoningEdge; weight: number }>();
  const frontier: State[] = [
    { id: sourceId, cost: 0, depth: 0, prev: null, edge: null, weight: 1 },
  ];

  while (frontier.length > 0) {
    frontier.sort((a, b) => a.cost - b.cost);
    const cur = frontier.shift()!;
    if (cur.id === targetId) break;
    if (cur.depth >= maxDepth) continue;

    for (const { id: nextId, edge } of adj.neighbours.get(cur.id) ?? []) {
      const w = clampWeight(edge.weight, minWeight);
      const nextCost = cur.cost + (-Math.log(w));
      const known = best.get(nextId);
      if (known !== undefined && known <= nextCost) continue;
      best.set(nextId, nextCost);
      prev.set(nextId, { id: cur.id, edge, weight: w });
      frontier.push({
        id: nextId,
        cost: nextCost,
        depth: cur.depth + 1,
        prev: cur.id,
        edge,
        weight: w,
      });
    }
  }

  if (!prev.has(targetId)) return null;

  // Reconstruct path target → source then reverse.
  const ids: string[] = [targetId];
  const reverseSteps: ReasoningStep[] = [];
  let cursor = targetId;
  while (cursor !== sourceId) {
    const p = prev.get(cursor);
    if (!p) return null;
    reverseSteps.push({ from: p.id, to: cursor, edge: p.edge, weight: p.weight });
    ids.push(p.id);
    cursor = p.id;
  }
  ids.reverse();
  reverseSteps.reverse();
  const nodes = ids.map((id) => adj.nodes.get(id) ?? { id });
  const strength = reverseSteps.reduce((acc, s) => acc * s.weight, 1);
  return {
    source: sourceId,
    target: targetId,
    nodes,
    steps: reverseSteps,
    strength,
    length: reverseSteps.length,
  };
}

function clampWeight(w: number | undefined, min: number): number {
  if (w === undefined || !Number.isFinite(w)) return min;
  if (w <= min) return min;
  if (w >= 1) return 1;
  return w;
}
