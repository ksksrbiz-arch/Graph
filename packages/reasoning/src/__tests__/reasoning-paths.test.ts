import { describe, expect, it } from 'vitest';
import type { ReasoningGraph } from '../graph-features.js';
import { findReasoningPath } from '../reasoning-paths.js';

const graph: ReasoningGraph = {
  nodes: [
    { id: 'a', label: 'Alice' },
    { id: 'b', label: 'Bob' },
    { id: 'c', label: 'Carol' },
    { id: 'd', label: 'Dave' },
    { id: 'e', label: 'Eve' },
    { id: 'island', label: 'Disconnected' },
  ],
  edges: [
    { source: 'a', target: 'b', weight: 0.9, relation: 'KNOWS' },
    { source: 'b', target: 'c', weight: 0.8, relation: 'WORKS_WITH' },
    { source: 'c', target: 'd', weight: 0.7, relation: 'EMAILED' },
    { source: 'a', target: 'e', weight: 0.2, relation: 'CC_ED' },
    { source: 'e', target: 'd', weight: 0.2, relation: 'CC_ED' },
  ],
};

describe('findReasoningPath', () => {
  it('returns the strongest path between two nodes', () => {
    const path = findReasoningPath(graph, 'a', 'd');
    expect(path).not.toBeNull();
    // a→b (0.9) → c (0.8) → d (0.7) = 0.504
    // a→e (0.2) → d (0.2) = 0.04
    expect(path!.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(path!.strength).toBeCloseTo(0.504, 3);
    expect(path!.length).toBe(3);
    expect(path!.steps).toHaveLength(3);
    expect(path!.steps[0]!.edge.relation).toBe('KNOWS');
  });

  it('returns null when source equals target', () => {
    expect(findReasoningPath(graph, 'a', 'a')).toBeNull();
  });

  it('returns null when target is unreachable', () => {
    expect(findReasoningPath(graph, 'a', 'island')).toBeNull();
  });

  it('returns null when an unknown node is supplied', () => {
    expect(findReasoningPath(graph, 'a', 'ghost')).toBeNull();
    expect(findReasoningPath(graph, 'ghost', 'a')).toBeNull();
  });

  it('respects maxDepth', () => {
    // a—c is reachable only via b: a→b→c (2 hops). depth=1 must give up.
    expect(findReasoningPath(graph, 'a', 'c', { maxDepth: 1 })).toBeNull();
    expect(findReasoningPath(graph, 'a', 'c', { maxDepth: 2 })).not.toBeNull();
  });

  it('handles edges without a weight by treating them as the floor', () => {
    const g: ReasoningGraph = {
      nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      edges: [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'c' },
      ],
    };
    const path = findReasoningPath(g, 'a', 'c');
    expect(path).not.toBeNull();
    expect(path!.length).toBe(2);
    expect(path!.strength).toBeGreaterThan(0);
  });
});
