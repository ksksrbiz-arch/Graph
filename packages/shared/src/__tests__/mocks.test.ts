import { describe, expect, it } from 'vitest';
import { generateGraph, generateNodes } from '../mocks/index.js';

describe('mock generator', () => {
  it('produces the requested node count', () => {
    expect(generateNodes(100, { seed: 1 })).toHaveLength(100);
  });

  it('switches to sparse-edge mode for large graphs', () => {
    const { nodes, edges } = generateGraph(2_500, 0.001, { seed: 1 });
    expect(nodes).toHaveLength(2_500);
    // sparse path caps edges at ~avgDegree*n
    expect(edges.length).toBeLessThan(nodes.length * 5);
  });

  it('seed produces identical node sequence', () => {
    const a = generateNodes(20, { seed: 7 });
    const b = generateNodes(20, { seed: 7 });
    expect(a.map((n) => n.label)).toEqual(b.map((n) => n.label));
  });
});
