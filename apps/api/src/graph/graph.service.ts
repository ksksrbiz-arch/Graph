import { Injectable } from '@nestjs/common';
import type { Subgraph } from '@pkg/shared';
import { GraphRepository } from './graph.repository';

@Injectable()
export class GraphService {
  constructor(private readonly repo: GraphRepository) {}

  subgraph(userId: string, rootId: string, depth = 2): Promise<Subgraph> {
    return this.repo.subgraph(userId, rootId, depth);
  }

  deleteNode(userId: string, id: string): Promise<boolean> {
    return this.repo.deleteNode(userId, id);
  }
}
