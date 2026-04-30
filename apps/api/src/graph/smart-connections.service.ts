// Smart Connections service — finds the most semantically similar nodes in the
// graph for a given query node using cosine similarity over the pre-computed
// embedding vectors stored on KGNode.
//
// Embeddings are 384-dimensional float arrays stored in Neo4j under the
// `embeddingJson` property (JSON-encoded string, same pattern as metadataJson).
// If a node has no embedding the service falls back to label-based tag overlap.
//
// The similarity search is intentionally done in-process rather than in Neo4j
// so we don't need the APOC/GDS vector plugin during Phase 0.  For large graphs
// (> 10k nodes) this should be offloaded to Meilisearch vector search in Phase 5.

import { Injectable } from '@nestjs/common';
import type { KGNode } from '@pkg/shared';
import { GraphRepository } from './graph.repository';

export interface SimilarNode {
  node: KGNode;
  score: number;
}

const DEFAULT_TOP_N = 10;
const EMBEDDING_DIM = 384;

@Injectable()
export class SmartConnectionsService {
  constructor(private readonly repo: GraphRepository) {}

  /**
   * Return the top-N most similar nodes to `rootId` for the given user.
   * Similarity is computed as cosine similarity between embedding vectors when
   * available, falling back to Jaccard similarity on tag words from the label.
   *
   * @param userId    — the owning user
   * @param rootId    — id of the anchor node
   * @param topN      — how many neighbours to return (capped at 50)
   */
  async findSimilar(
    userId: string,
    rootId: string,
    topN = DEFAULT_TOP_N,
  ): Promise<SimilarNode[]> {
    const limit = Math.max(1, Math.min(50, topN));

    const { nodes } = await this.repo.snapshotForUser(userId, 5_000);

    const anchor = nodes.find((n) => n.id === rootId);
    if (!anchor) return [];

    const anchorEmbedding = parseEmbedding(anchor);
    const anchorTokens = tokenise(anchor.label);

    const scored: SimilarNode[] = [];

    for (const node of nodes) {
      if (node.id === rootId) continue;
      if (node.deletedAt) continue;

      let score: number;
      const candidateEmbedding = parseEmbedding(node);

      if (anchorEmbedding && candidateEmbedding) {
        score = cosineSimilarity(anchorEmbedding, candidateEmbedding);
      } else {
        // Label-token Jaccard fallback
        const candidateTokens = tokenise(node.label);
        score = jaccardSimilarity(anchorTokens, candidateTokens);
      }

      if (score > 0) {
        scored.push({ node, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function parseEmbedding(node: KGNode): number[] | null {
  const raw = (node as KGNode & { embeddingJson?: unknown }).embeddingJson;
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const arr: unknown = JSON.parse(raw);
    if (Array.isArray(arr) && arr.length === EMBEDDING_DIM) {
      return arr as number[];
    }
  } catch {
    // ignore
  }
  return null;
}

/** Cosine similarity between two equal-length numeric vectors. */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** Tokenise a label string into lower-case words (stop-words excluded). */
function tokenise(label: string): Set<string> {
  const STOP = new Set([
    'a', 'an', 'the', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or',
    'is', 'are', 'was', 'be', 'with', 'by', 'from', 'this', 'that',
  ]);
  const tokens = new Set<string>();
  for (const word of label.toLowerCase().split(/\W+/)) {
    if (word.length > 1 && !STOP.has(word)) tokens.add(word);
  }
  return tokens;
}

/** Jaccard similarity: |intersection| / |union| */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
