// Vector similarity primitives. All functions assume real-valued, finite
// inputs; NaN-tolerant behaviour is documented per function.

/** Cosine similarity in [-1, 1]. Returns 0 if either side is the zero vector
 *  or if the dimensions don't match — both are degenerate inputs that have no
 *  meaningful angle. */
export function cosineSim(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Dot product. Use this when both inputs are already L2-normalised — saves
 *  the two sqrt() calls in cosineSim. */
export function dot(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += (a[i] ?? 0) * (b[i] ?? 0);
  return d;
}

export interface ScoredItem<T> {
  item: T;
  score: number;
}

/** Return the top-k items by `scoreFn` (descending). Stable order is not
 *  guaranteed for ties — callers that need it should pre-sort. */
export function topK<T>(
  items: T[],
  scoreFn: (item: T) => number,
  k: number,
): ScoredItem<T>[] {
  if (k <= 0 || items.length === 0) return [];
  const scored = items.map((item) => ({ item, score: scoreFn(item) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}
