import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EMBEDDING_DIM,
  embed,
  fnv1a,
  meanVector,
  tokenize,
} from '../embeddings.js';
import { cosineSim } from '../similarity.js';

describe('fnv1a', () => {
  it('is deterministic for the same input', () => {
    expect(fnv1a('hello')).toBe(fnv1a('hello'));
  });

  it('separates similar inputs into different buckets', () => {
    expect(fnv1a('cat')).not.toBe(fnv1a('cab'));
  });
});

describe('tokenize', () => {
  it('lowercases by default and splits on non-word chars', () => {
    expect(tokenize('Hello, World!')).toEqual(['hello', 'world']);
  });

  it('drops empty tokens', () => {
    expect(tokenize('   ')).toEqual([]);
  });
});

describe('embed', () => {
  it('produces a 384-dimensional vector by default', () => {
    expect(embed('quick brown fox')).toHaveLength(DEFAULT_EMBEDDING_DIM);
  });

  it('produces L2-normalised vectors (or all zeros for empty input)', () => {
    const v = embed('graph reasoning paths');
    const norm = Math.sqrt(v.reduce((acc, x) => acc + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it('returns a zero vector for empty input', () => {
    const v = embed('   ');
    expect(v.every((x) => x === 0)).toBe(true);
  });

  it('is deterministic across calls', () => {
    expect(embed('alpha beta')).toEqual(embed('alpha beta'));
  });

  it('makes related sentences more similar than unrelated ones', () => {
    const a = embed('graph database neo4j');
    const b = embed('graph database storage');
    const c = embed('lasagna pasta tomato');
    expect(cosineSim(a, b)).toBeGreaterThan(cosineSim(a, c));
  });

  it('respects a custom dimension', () => {
    expect(embed('hello', { dim: 64 })).toHaveLength(64);
  });

  it('rejects an invalid dimension', () => {
    expect(() => embed('x', { dim: 0 })).toThrow();
    expect(() => embed('x', { dim: -5 })).toThrow();
  });
});

describe('meanVector', () => {
  it('returns the centroid of the inputs', () => {
    const m = meanVector([
      [1, 0, 0],
      [0, 1, 0],
    ]);
    expect(m).toEqual([0.5, 0.5, 0]);
  });

  it('returns an empty vector when inputs are empty', () => {
    expect(meanVector([])).toEqual([]);
  });

  it('skips inputs with mismatched dimensions', () => {
    const m = meanVector([
      [1, 1, 1],
      [9, 9],
    ]);
    expect(m).toEqual([1, 1, 1]);
  });
});
