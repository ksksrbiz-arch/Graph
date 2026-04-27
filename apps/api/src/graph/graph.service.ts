import { Injectable } from '@nestjs/common';
import type { Subgraph } from '@pkg/shared';
import { GraphRepository } from './graph.repository';
import { SmartConnectionsService, type SimilarNode } from './smart-connections.service';

@Injectable()
export class GraphService {
  constructor(
    private readonly repo: GraphRepository,
    private readonly smartConnections: SmartConnectionsService,
  ) {}

  subgraph(userId: string, rootId: string, depth = 2): Promise<Subgraph> {
    return this.repo.subgraph(userId, rootId, depth);
  }

  deleteNode(userId: string, id: string): Promise<boolean> {
    return this.repo.deleteNode(userId, id);
  }

  findSimilar(userId: string, nodeId: string, topN = 10): Promise<SimilarNode[]> {
    return this.smartConnections.findSimilar(userId, nodeId, topN);
  }
}
