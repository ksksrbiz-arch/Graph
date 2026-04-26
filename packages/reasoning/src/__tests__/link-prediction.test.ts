import { describe, expect, it } from 'vitest';
import type { ReasoningGraph } from '../graph-features.js';
import { predictLinks } from '../link-prediction.js';

const graph: ReasoningGraph = {
  nodes: [
    { id: 'a' },
    { id: 'b' },
    { id: 'c' },
    { id: 'd' },
    { id: 'e' },
    { id: 'f' },
  ],
  // a — b — d
  //  \  |   |
  //   \ c — e
  //         |
  //         f
  edges: [
    { source: 'a', target: 'b', weight: 0.8 },
    { source: 'a', target: 'c', weight: 0.6 },
    { source: 'b', target: 'c', weight: 0.7 },
    { source: 'b', target: 'd', weight: 0.5 },
    { source: 'c', target: 'e', weight: 0.6 },
    { source: 'd', target: 'e', weight: 0.4 },
    { source: 'e', target: 'f', weight: 0.5 },
  ],
};

describe('predictLinks', () => {
  it('returns the highest-scoring non-neighbours for the source', () => {
    const preds = predictLinks(graph, 'a', { method: 'common-neighbours', limit: 5 });
    const targets = preds.map((p) => p.target);
    // a's neighbours = {b, c}. Candidates with shared neighbours: d (b), e (c).
    expect(targets).toEqual(expect.arrayContaining(['d', 'e']));
    expect(targets).not.toContain('a');
    expect(targets).not.toContain('b');
    expect(targets).not.toContain('c');
  });

  it('jaccard normalises by union size', () => {
    const preds = predictLinks(graph, 'a', { method: 'jaccard', limit: 5 });
    for (const p of preds) {
      expect(p.score).toBeGreaterThanOrEqual(0);
      expect(p.score).toBeLessThanOrEqual(1);
    }
  });

  it('adamic-adar rewards rare common neighbours', () => {
    const preds = predictLinks(graph, 'a', { method: 'adamic-adar', limit: 5 });
    expect(preds.length).toBeGreaterThan(0);
    expect(preds[0]!.score).toBeGreaterThan(0);
  });

  it('respects the limit', () => {
    const preds = predictLinks(graph, 'a', { method: 'common-neighbours', limit: 1 });
    expect(preds).toHaveLength(1);
  });

  it('respects the candidate filter', () => {
    const preds = predictLinks(graph, 'a', {
      method: 'common-neighbours',
      limit: 10,
      candidateFilter: (id) => id !== 'd',
    });
    expect(preds.map((p) => p.target)).not.toContain('d');
  });

  it('returns [] for an isolated source', () => {
    const isolated: ReasoningGraph = {
      nodes: [{ id: 'lonely' }, { id: 'a' }, { id: 'b' }],
      edges: [{ source: 'a', target: 'b' }],
    };
    expect(predictLinks(isolated, 'lonely')).toEqual([]);
  });

  it('returns [] for an unknown source', () => {
    expect(predictLinks(graph, 'no-such-node')).toEqual([]);
  });
});
