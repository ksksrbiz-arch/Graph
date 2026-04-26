// Structural link-prediction scoring. Given a graph and a source node, rank
// non-neighbours by how likely they are to share a missing edge with the
// source. Three classic scores are supported; callers pick by `method`.
//
//  • common-neighbours: |N(a) ∩ N(b)|
//  • jaccard:           |N(a) ∩ N(b)| / |N(a) ∪ N(b)|
//  • adamic-adar:       Σ_{z ∈ N(a)∩N(b)} 1 / log(1 + |N(z)|)
//
// Adamic-Adar weights rare hubs higher, which tends to suit knowledge graphs
// where popular nodes (e.g. a single "person" connected to thousands of
// emails) would otherwise dominate.

import {
  buildAdjacency,
  degree,
  neighbourSet,
  type Adjacency,
  type ReasoningGraph,
} from './graph-features.js';

export type LinkPredictionMethod =
  | 'common-neighbours'
  | 'jaccard'
  | 'adamic-adar';

export interface LinkPrediction {
  /** Candidate node id. */
  target: string;
  /** Score under the chosen method. Higher = more likely. */
  score: number;
  /** Number of common neighbours — useful for explanations even when the
   *  primary score is Jaccard or Adamic-Adar. */
  commonNeighbours: number;
}

export interface PredictLinksOptions {
  method?: LinkPredictionMethod;
  /** Maximum number of candidates to return. */
  limit?: number;
  /** Minimum score to include — filtered before `limit` is applied. */
  minScore?: number;
  /** Candidate filter — return false to exclude. Useful to drop nodes already
   *  connected (default behaviour) or to apply user-level isolation. */
  candidateFilter?: (candidateId: string) => boolean;
}

/**
 * Predict the most likely missing links from `sourceId`. Existing direct
 * neighbours and `sourceId` itself are always excluded from the candidate
 * pool.
 *
 * Returns an empty array if `sourceId` is not in the graph or has degree 0.
 */
export function predictLinks(
  graph: ReasoningGraph,
  sourceId: string,
  opts: PredictLinksOptions = {},
): LinkPrediction[] {
  const method = opts.method ?? 'adamic-adar';
  const limit = opts.limit ?? 10;
  const minScore = opts.minScore ?? 0;

  const adj = buildAdjacency(graph);
  const sourceNeighbours = neighbourSet(adj, sourceId);
  if (sourceNeighbours.size === 0) return [];

  const candidates = new Set<string>();
  // Walk to neighbours-of-neighbours; only those can have a non-zero score
  // under any of the three methods. Saves us iterating the whole graph.
  for (const n of sourceNeighbours) {
    for (const neighbour of adj.neighbours.get(n) ?? []) {
      const id = neighbour.id;
      if (id === sourceId) continue;
      if (sourceNeighbours.has(id)) continue;
      if (opts.candidateFilter && !opts.candidateFilter(id)) continue;
      candidates.add(id);
    }
  }

  const out: LinkPrediction[] = [];
  for (const target of candidates) {
    const targetNeighbours = neighbourSet(adj, target);
    const intersection = intersect(sourceNeighbours, targetNeighbours);
    if (intersection.size === 0) continue;
    const score = scoreFor(method, adj, sourceNeighbours, targetNeighbours, intersection);
    if (score < minScore) continue;
    out.push({ target, score, commonNeighbours: intersection.size });
  }

  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

function scoreFor(
  method: LinkPredictionMethod,
  adj: Adjacency,
  a: Set<string>,
  b: Set<string>,
  intersection: Set<string>,
): number {
  switch (method) {
    case 'common-neighbours':
      return intersection.size;
    case 'jaccard': {
      const union = a.size + b.size - intersection.size;
      return union === 0 ? 0 : intersection.size / union;
    }
    case 'adamic-adar': {
      let s = 0;
      for (const z of intersection) {
        const d = degree(adj, z);
        // log(1 + d) is the standard variant; it avoids log(1) = 0 blow-up
        // when a common neighbour has degree exactly 1.
        s += 1 / Math.log(1 + Math.max(2, d));
      }
      return s;
    }
  }
}

function intersect(a: Set<string>, b: Set<string>): Set<string> {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  const out = new Set<string>();
  for (const x of small) if (large.has(x)) out.add(x);
  return out;
}
