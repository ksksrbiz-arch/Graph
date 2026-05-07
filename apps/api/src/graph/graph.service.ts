import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import type { CursorPage, GraphDeltaEvent, KGEdge, KGNode, NodeType, Subgraph } from '@pkg/shared';
import { SearchService } from '../shared/meilisearch/search.service';
import { GraphGateway } from './graph.gateway';
import { GraphRepository } from './graph.repository';
import { SmartConnectionsService, type SimilarNode } from './smart-connections.service';

@Injectable()
export class GraphService {
  constructor(
    private readonly repo: GraphRepository,
    private readonly smartConnections: SmartConnectionsService,
    private readonly search: SearchService,
    @Optional() private readonly gateway: GraphGateway | null,
  ) {}

  /** Write a node to Neo4j, index it in Meilisearch, and emit a delta event. */
  async upsertNode(userId: string, node: KGNode): Promise<boolean> {
    const wrote = await this.repo.upsertNode(userId, node);
    if (wrote) {
      await this.search.indexNode(userId, node);
      this.emitDelta(userId, {
        type: 'NODES_ADDED',
        nodes: [node],
        timestamp: new Date().toISOString(),
      });
    }
    return wrote;
  }

  /** Write an edge to Neo4j and emit a delta event. */
  async upsertEdge(userId: string, edge: KGEdge): Promise<boolean> {
    const wrote = await this.repo.upsertEdge(userId, edge);
    if (wrote) {
      this.emitDelta(userId, {
        type: 'EDGES_ADDED',
        edges: [edge],
        timestamp: new Date().toISOString(),
      });
    }
    return wrote;
  }

  subgraph(userId: string, rootId: string, depth = 2): Promise<Subgraph> {
    return this.repo.subgraph(userId, rootId, depth);
  }

  listNodes(
    userId: string,
    cursor?: string,
    limit = 100,
    type?: NodeType,
  ): Promise<CursorPage<KGNode>> {
    return this.repo.listNodes(userId, cursor, limit, type);
  }

  async getNode(userId: string, id: string): Promise<KGNode> {
    const node = await this.repo.getNode(userId, id);
    if (!node) throw new NotFoundException(`Node ${id} not found`);
    return node;
  }

  async deleteNode(userId: string, id: string): Promise<boolean> {
    const deleted = await this.repo.deleteNode(userId, id);
    if (deleted) {
      await this.search.deleteNode(userId, id);
      this.emitDelta(userId, {
        type: 'NODES_DELETED',
        nodes: [{ id } as KGNode],
        timestamp: new Date().toISOString(),
      });
    }
    return deleted;
  }

  searchNodes(userId: string, q: string, limit = 20) {
    return this.search.search(userId, q, limit);
  }

  findSimilar(userId: string, nodeId: string, topN = 10): Promise<SimilarNode[]> {
    return this.smartConnections.findSimilar(userId, nodeId, topN);
  }

  /** Full graph snapshot for a user. Used by the public/demo path so the SPA
   *  can render the graph without a full GraphQL setup. */
  snapshotForUser(userId: string, limit = 50_000) {
    return this.repo.snapshotForUser(userId, limit);
  }

  /** Nodes + edges added strictly after `sinceIso`. Drives the SPA's poll
   *  loop in web/graph-live.js — passthrough to the repository. */
  snapshotDeltaForUser(userId: string, sinceIso: string, limit = 50_000) {
    return this.repo.snapshotDeltaForUser(userId, sinceIso, limit);
  }

  private emitDelta(userId: string, event: GraphDeltaEvent): void {
    this.gateway?.emitDelta(userId, event);
  }
}
