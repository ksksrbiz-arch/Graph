import { describe, expect, it } from 'vitest';
import { cosineSim, dot, topK } from '../similarity.js';

describe('cosineSim', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosineSim([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
  });

  it('returns -1 for opposing vectors', () => {
    expect(cosineSim([1, 0], [-1, 0])).toBeCloseTo(-1, 6);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSim([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });

  it('returns 0 when either side is the zero vector', () => {
    expect(cosineSim([0, 0], [1, 1])).toBe(0);
  });

  it('returns 0 on dimension mismatch', () => {
    expect(cosineSim([1, 2], [1, 2, 3])).toBe(0);
  });
});

describe('dot', () => {
  it('computes the inner product', () => {
    expect(dot([1, 2, 3], [4, 5, 6])).toBe(32);
  });

  it('returns 0 on dimension mismatch', () => {
    expect(dot([1], [1, 2])).toBe(0);
  });
});

describe('topK', () => {
  it('returns the k highest-scoring items in descending order', () => {
    const items = [{ x: 1 }, { x: 5 }, { x: 3 }, { x: 9 }, { x: 2 }];
    const top = topK(items, (i) => i.x, 3);
    expect(top.map((s) => s.item.x)).toEqual([9, 5, 3]);
  });

  it('returns all items if k >= length', () => {
    expect(topK([1, 2], (n) => n, 10)).toHaveLength(2);
  });

  it('returns [] when k <= 0', () => {
    expect(topK([1, 2], (n) => n, 0)).toEqual([]);
  });
});
