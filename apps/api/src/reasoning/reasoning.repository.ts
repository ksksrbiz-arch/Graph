// Neo4j adapter for the reasoning service. Pulls just enough graph data into
// the `@pkg/reasoning` `ReasoningGraph` shape so the algorithms in that
// package can run over it without knowing anything about Cypher or labels.
//
// All queries are scoped by `userId` so reasoning never leaks across tenants.

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Driver } from 'neo4j-driver';
import type { ReasoningGraph } from '@pkg/reasoning';
import { NEO4J_DRIVER } from '../shared/neo4j/neo4j.module';

export interface ReasoningNodeRecord {
  id: string;
  label: string;
  type: string;
  metadataJson?: string | null;
}

@Injectable()
export class ReasoningRepository {
  private readonly log = new Logger(ReasoningRepository.name);

  constructor(@Inject(NEO4J_DRIVER) private readonly driver: Driver) {}

  /**
   * Load every non-deleted node + edge for `userId`. Returns the `ReasoningGraph`
   * shape consumed by `@pkg/reasoning`. Capped at `limit` nodes for safety.
   */
  async loadUserGraph(userId: string, limit = 5_000): Promise<ReasoningGraph> {
    const session = this.driver.session();
    try {
      const nodesRes = await session.run(
        `MATCH (n:KGNode {userId: $userId})
         WHERE n.deletedAt IS NULL
         RETURN n.id AS id, n.label AS label, n.type AS type
         LIMIT $limit`,
        { userId, limit },
      );
      const nodes = nodesRes.records.map((r) => ({
        id: String(r.get('id')),
        label: r.get('label') == null ? undefined : String(r.get('label')),
        type: r.get('type') == null ? undefined : String(r.get('type')),
      }));

      const edgesRes = await session.run(
        `MATCH (a:KGNode {userId: $userId})-[r:REL]->(b:KGNode {userId: $userId})
         WHERE a.deletedAt IS NULL AND b.deletedAt IS NULL
         RETURN a.id AS source, b.id AS target, r.weight AS weight, r.relation AS relation
         LIMIT $limit`,
        { userId, limit: limit * 4 },
      );
      const edges = edgesRes.records.map((r) => ({
        source: String(r.get('source')),
        target: String(r.get('target')),
        weight: Number(r.get('weight') ?? 0.5),
        relation: r.get('relation') == null ? undefined : String(r.get('relation')),
      }));

      return { nodes, edges };
    } finally {
      await session.close();
    }
  }

  /** Fetch a single node's label/type/metadata for embedding-based queries. */
  async loadNode(userId: string, nodeId: string): Promise<ReasoningNodeRecord | null> {
    const session = this.driver.session();
    try {
      const res = await session.run(
        `MATCH (n:KGNode {userId: $userId, id: $nodeId})
         WHERE n.deletedAt IS NULL
         RETURN n.id AS id, n.label AS label, n.type AS type, n.metadataJson AS metadataJson
         LIMIT 1`,
        { userId, nodeId },
      );
      const record = res.records[0];
      if (!record) return null;
      return {
        id: String(record.get('id')),
        label: String(record.get('label') ?? ''),
        type: String(record.get('type') ?? 'concept'),
        metadataJson: record.get('metadataJson') ?? null,
      };
    } finally {
      await session.close();
    }
  }

  /** Fetch every (id, label) for label-based embedding similarity. */
  async loadNodeLabels(
    userId: string,
    limit = 5_000,
  ): Promise<Array<{ id: string; label: string; type: string }>> {
    const session = this.driver.session();
    try {
      const res = await session.run(
        `MATCH (n:KGNode {userId: $userId})
         WHERE n.deletedAt IS NULL AND n.label IS NOT NULL
         RETURN n.id AS id, n.label AS label, n.type AS type
         LIMIT $limit`,
        { userId, limit },
      );
      return res.records.map((r) => ({
        id: String(r.get('id')),
        label: String(r.get('label') ?? ''),
        type: String(r.get('type') ?? 'concept'),
      }));
    } finally {
      await session.close();
    }
  }
}
