// Glue between the API and the `@pkg/reasoning` primitives. This is where the
// per-user knowledge graph gets loaded once per request, transformed, and
// handed to the pure algorithms in the reasoning package.
//
// The service is intentionally stateless — every request reloads the graph
// snapshot it needs. A future optimisation would cache the adjacency map per
// user with a short TTL, invalidated on graph writes.

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  classifyNode,
  cosineSim,
  embed,
  findReasoningPath,
  predictLinks,
  topK,
  type ClassificationResult,
  type ClassifyInput,
  type LinkPrediction,
  type LinkPredictionMethod,
  type ReasoningPath,
} from '@pkg/reasoning';
import { ReasoningRepository } from './reasoning.repository';

export interface SimilarNodeResult {
  id: string;
  label: string;
  type: string;
  /** Cosine similarity in [0, 1] for these L2-normalised embeddings. */
  similarity: number;
}

export interface ReasoningSummary {
  nodeId: string;
  /** Distribution of neighbour types — useful for deciding what kind of node
   *  this is by association. */
  neighbourTypes: Record<string, number>;
  /** Number of unique neighbours. */
  degree: number;
  /** Strongest neighbour by edge weight (for "the most important link"). */
  topNeighbour: { id: string; label?: string; weight: number } | null;
}

@Injectable()
export class ReasoningService {
  private readonly log = new Logger(ReasoningService.name);

  constructor(private readonly repo: ReasoningRepository) {}

  /** Embed an arbitrary text — exposed primarily so connectors can fill in
   *  KGNode.embedding at sync time. Pure function; no Neo4j round-trip. */
  embedText(text: string): number[] {
    return embed(text);
  }

  /** Classify a label/URL/connector tuple into a NodeType. */
  classify(input: ClassifyInput): ClassificationResult {
    return classifyNode(input);
  }

  /** Top-N nodes most semantically similar to the given node's label. */
  async similarNodes(
    userId: string,
    nodeId: string,
    limit = 10,
  ): Promise<SimilarNodeResult[]> {
    const seed = await this.repo.loadNode(userId, nodeId);
    if (!seed) throw new NotFoundException(`node ${nodeId} not found for user`);
    const seedVec = embed(seed.label);
    const all = await this.repo.loadNodeLabels(userId);
    const others = all.filter((n) => n.id !== nodeId);
    const ranked = topK(
      others,
      (n) => cosineSim(seedVec, embed(n.label)),
      limit,
    );
    return ranked.map((s) => ({
      id: s.item.id,
      label: s.item.label,
      type: s.item.type,
      similarity: s.score,
    }));
  }

  /** Top-N candidate edges from `nodeId` ranked by the chosen structural
   *  scorer. Excludes existing direct neighbours. */
  async predictLinks(
    userId: string,
    nodeId: string,
    method: LinkPredictionMethod = 'adamic-adar',
    limit = 10,
  ): Promise<LinkPrediction[]> {
    const graph = await this.repo.loadUserGraph(userId);
    return predictLinks(graph, nodeId, { method, limit });
  }

  /** Strongest reasoning path between two nodes (Dijkstra over -log weights). */
  async reasoningPath(
    userId: string,
    sourceId: string,
    targetId: string,
    maxDepth = 4,
  ): Promise<ReasoningPath | null> {
    const graph = await this.repo.loadUserGraph(userId);
    return findReasoningPath(graph, sourceId, targetId, { maxDepth });
  }

  /** Coarse summary of a node's neighbourhood. Cheap; avoids loading the full
   *  graph by querying only one hop. */
  async summarise(userId: string, nodeId: string): Promise<ReasoningSummary> {
    const graph = await this.repo.loadUserGraph(userId);
    const incident = graph.edges.filter(
      (e) => e.source === nodeId || e.target === nodeId,
    );
    if (!graph.nodes.find((n) => n.id === nodeId)) {
      throw new NotFoundException(`node ${nodeId} not found for user`);
    }

    const neighbourCounts = new Map<string, number>();
    let topNeighbour: { id: string; label?: string; weight: number } | null = null;
    for (const e of incident) {
      const otherId = e.source === nodeId ? e.target : e.source;
      const node = graph.nodes.find((n) => n.id === otherId);
      const t = node?.type ?? 'unknown';
      neighbourCounts.set(t, (neighbourCounts.get(t) ?? 0) + 1);
      const w = e.weight ?? 0.5;
      if (topNeighbour === null || w > topNeighbour.weight) {
        topNeighbour = {
          id: otherId,
          ...(node?.label !== undefined ? { label: node.label } : {}),
          weight: w,
        };
      }
    }

    return {
      nodeId,
      neighbourTypes: Object.fromEntries(neighbourCounts),
      degree: new Set(
        incident.map((e) => (e.source === nodeId ? e.target : e.source)),
      ).size,
      topNeighbour,
    };
  }
}
