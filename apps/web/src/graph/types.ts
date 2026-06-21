import type { KGNode, KGEdge } from '@pkg/shared';

/** A KGNode augmented with the runtime fields force-graph attaches plus the
 *  pre-computed degree used for size encoding. */
export interface GraphNode extends KGNode {
  degree: number;
  x?: number;
  y?: number;
}

/** A KGEdge mapped for force-graph. `source`/`target` start as node ids and
 *  are mutated into node references by the engine after the first tick. */
export interface GraphLink {
  id: string;
  source: string | GraphNode;
  target: string | GraphNode;
  relation: KGEdge['relation'];
  weight: number;
  inferred: boolean;
}

export interface ViewGraph {
  nodes: GraphNode[];
  links: GraphLink[];
}

/** Build the force-graph view model from raw API nodes/edges, computing degree
 *  and dropping edges whose endpoints aren't present. */
export function toViewGraph(nodes: KGNode[], edges: KGEdge[]): ViewGraph {
  const present = new Set(nodes.map((n) => n.id));
  const degree = new Map<string, number>();
  const links: GraphLink[] = [];
  for (const e of edges) {
    if (!present.has(e.source) || !present.has(e.target)) continue;
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    links.push({
      id: e.id,
      source: e.source,
      target: e.target,
      relation: e.relation,
      weight: e.weight,
      inferred: e.inferred,
    });
  }
  const viewNodes: GraphNode[] = nodes.map((n) => ({ ...n, degree: degree.get(n.id) ?? 0 }));
  return { nodes: viewNodes, links };
}

/** Resolve a link endpoint to its node id whether it's still a string or has
 *  already been hydrated into a node object by the engine. */
export function endpointId(end: string | GraphNode): string {
  return typeof end === 'string' ? end : end.id;
}
