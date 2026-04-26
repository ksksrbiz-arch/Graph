// Spec Appendix B — sample mock data generator. Used by:
//   • api seed script (`pnpm --filter @pkg/api db:seed`)
//   • frontend Storybook stories
//   • performance test fixtures (k6)
//
// Deterministic when callers pass a seeded `faker` instance.

import { faker as defaultFaker, type Faker } from '@faker-js/faker';
import {
  CONNECTOR_IDS,
  EDGE_RELATIONS,
  NODE_TYPES,
  type ConnectorId,
  type EdgeRelation,
  type KGEdge,
  type KGNode,
  type NodeType,
} from '../types.js';

export interface GenerateOptions {
  faker?: Faker;
  /** Seed for determinism. Ignored if `faker` is supplied. */
  seed?: number;
}

function pickFaker(opts: GenerateOptions = {}): Faker {
  if (opts.faker) return opts.faker;
  if (opts.seed !== undefined) defaultFaker.seed(opts.seed);
  return defaultFaker;
}

export function generateNodes(count: number, opts: GenerateOptions = {}): KGNode[] {
  const fk = pickFaker(opts);
  const nodes: KGNode[] = [];
  for (let i = 0; i < count; i++) {
    const created = fk.date.past({ years: 2 });
    const updated = fk.date.between({ from: created, to: new Date() });
    nodes.push({
      id: fk.string.uuid(),
      label: fk.lorem.words({ min: 1, max: 5 }),
      type: fk.helpers.arrayElement(NODE_TYPES) as NodeType,
      createdAt: created.toISOString(),
      updatedAt: updated.toISOString(),
      metadata: {},
      sourceId: fk.helpers.arrayElement(CONNECTOR_IDS) as ConnectorId,
      sourceUrl: fk.internet.url(),
    });
  }
  return nodes;
}

/**
 * Generate edges between the given nodes.
 *
 * `density` is the probability that any given undirected pair is connected.
 * Note this is O(n²) — for >5k nodes prefer `generateEdgesSparse`.
 */
export function generateEdges(
  nodes: KGNode[],
  density = 0.05,
  opts: GenerateOptions = {},
): KGEdge[] {
  const fk = pickFaker(opts);
  const edges: KGEdge[] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (Math.random() >= density) continue;
      const a = nodes[i];
      const b = nodes[j];
      if (!a || !b) continue;
      edges.push({
        id: fk.string.uuid(),
        source: a.id,
        target: b.id,
        relation: fk.helpers.arrayElement(EDGE_RELATIONS) as EdgeRelation,
        weight: Number(fk.number.float({ min: 0, max: 1, fractionDigits: 3 })),
        inferred: fk.datatype.boolean(),
        createdAt: fk.date.recent({ days: 30 }).toISOString(),
        metadata: {},
      });
    }
  }
  return edges;
}

/**
 * Linear-time edge generator — each node gets `avgDegree` random neighbours.
 * Suitable for large graphs (>5k nodes) where the O(n²) generator would stall.
 */
export function generateEdgesSparse(
  nodes: KGNode[],
  avgDegree = 4,
  opts: GenerateOptions = {},
): KGEdge[] {
  const fk = pickFaker(opts);
  const edges: KGEdge[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    if (!a) continue;
    for (let k = 0; k < avgDegree; k++) {
      const j = fk.number.int({ min: 0, max: nodes.length - 1 });
      if (j === i) continue;
      const b = nodes[j];
      if (!b) continue;
      const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        id: fk.string.uuid(),
        source: a.id,
        target: b.id,
        relation: fk.helpers.arrayElement(EDGE_RELATIONS) as EdgeRelation,
        weight: Number(fk.number.float({ min: 0, max: 1, fractionDigits: 3 })),
        inferred: true,
        createdAt: fk.date.recent({ days: 30 }).toISOString(),
        metadata: {},
      });
    }
  }
  return edges;
}

export interface GeneratedGraph {
  nodes: KGNode[];
  edges: KGEdge[];
}

export function generateGraph(
  nodeCount = 200,
  density = 0.02,
  opts: GenerateOptions = {},
): GeneratedGraph {
  const nodes = generateNodes(nodeCount, opts);
  const edges =
    nodeCount > 2_000
      ? generateEdgesSparse(nodes, 4, opts)
      : generateEdges(nodes, density, opts);
  return { nodes, edges };
}
