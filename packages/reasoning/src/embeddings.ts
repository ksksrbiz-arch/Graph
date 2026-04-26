// Deterministic text embeddings via feature hashing. Produces a fixed-dimension
// vector (default 384 to match the KGNode.embedding contract) with no model
// weights, no network calls, and stable output across processes — same input
// always maps to the same vector.
//
// The approach: tokenise → hash each token into the vector with a signed
// increment → L2-normalise. This is a classic random-projection / hashing-trick
// embedding. It is deliberately simple: it captures lexical overlap, not
// semantics, so it is a serviceable lower bound until a real model lands.
//
// When higher-quality embeddings become available (e.g. MiniLM via onnx), this
// module's `embed()` is the single seam that needs to be swapped.

export const DEFAULT_EMBEDDING_DIM = 384;

export interface EmbedOptions {
  /** Dimension of the produced vector. Must be > 0. */
  dim?: number;
  /** Whether to lowercase tokens before hashing. Default true. */
  lowercase?: boolean;
}

/** FNV-1a 32-bit hash. Stable, fast, no deps. */
export function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // unsigned
  return h >>> 0;
}

/** Tokenise on non-word boundaries. Empty tokens are dropped. */
export function tokenize(text: string, lowercase = true): string[] {
  const normalised = lowercase ? text.toLowerCase() : text;
  return normalised.split(/[^a-z0-9]+/i).filter((t) => t.length > 0);
}

/**
 * Hash a tokenised string into a fixed-dimension dense vector and L2-normalise.
 *
 * Sign of each increment is determined by a second hash (`tokenHash >> 24 & 1`)
 * so that unrelated tokens cancel rather than reinforce — this gives the
 * embedding a small amount of distributional structure without a model.
 */
export function embed(text: string, opts: EmbedOptions = {}): number[] {
  const dim = opts.dim ?? DEFAULT_EMBEDDING_DIM;
  if (!Number.isInteger(dim) || dim <= 0) {
    throw new Error(`embed: dim must be a positive integer, got ${dim}`);
  }
  const lowercase = opts.lowercase ?? true;
  const vec = new Array<number>(dim).fill(0);

  const tokens = tokenize(text, lowercase);
  if (tokens.length === 0) return vec;

  for (const tok of tokens) {
    const h = fnv1a(tok);
    const idx = h % dim;
    const sign = (h >>> 24) & 1 ? 1 : -1;
    vec[idx] = (vec[idx] ?? 0) + sign;
  }

  // L2-normalise so cosineSim collapses to dot product on the consumer side.
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i]! * vec[i]!;
  if (norm === 0) return vec;
  const inv = 1 / Math.sqrt(norm);
  for (let i = 0; i < dim; i++) vec[i] = vec[i]! * inv;
  return vec;
}

/** Average a list of vectors (e.g. centroid of a neighbourhood). Skips empty
 *  inputs; returns a zero vector if every input is empty. */
export function meanVector(vectors: number[][], dim?: number): number[] {
  const inferredDim = dim ?? vectors.find((v) => v.length > 0)?.length ?? 0;
  if (inferredDim === 0) return [];
  const out = new Array<number>(inferredDim).fill(0);
  let n = 0;
  for (const v of vectors) {
    if (v.length !== inferredDim) continue;
    for (let i = 0; i < inferredDim; i++) out[i] = (out[i] ?? 0) + (v[i] ?? 0);
    n += 1;
  }
  if (n === 0) return out;
  for (let i = 0; i < inferredDim; i++) out[i] = (out[i] ?? 0) / n;
  return out;
}
