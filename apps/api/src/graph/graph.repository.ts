// Neo4j repository — implements the Cypher patterns documented in spec §8.2.
//
// Idempotency (Rule 12): every write uses MERGE; re-running the same source
// item must not duplicate nodes/edges.

import { Inject, Injectable } from '@nestjs/common';
import type { Driver, Record as Neo4jRecord } from 'neo4j-driver';
import type { KGEdge, KGNode, Subgraph } from '@pkg/shared';
import { NEO4J_DRIVER } from '../shared/neo4j/neo4j.module';

@Injectable()
export class GraphRepository {
  constructor(@Inject(NEO4J_DRIVER) private readonly driver: Driver) {}

  async upsertNode(userId: string, node: KGNode): Promise<void> {
    const session = this.driver.session();
    try {
      await session.run(
        `MERGE (n:KGNode {id: $id, userId: $userId})
         SET n += $props, n.updatedAt = datetime()`,
        { id: node.id, userId, props: this.nodeProps(node) },
      );
    } finally {
      await session.close();
    }
  }

  async upsertEdge(userId: string, edge: KGEdge): Promise<void> {
    const session = this.driver.session();
    try {
      await session.run(
        `MATCH (a:KGNode {id: $source, userId: $userId})
         MATCH (b:KGNode {id: $target, userId: $userId})
         MERGE (a)-[r:REL {id: $id}]->(b)
         SET r += $props`,
        {
          source: edge.source,
          target: edge.target,
          userId,
          id: edge.id,
          props: this.edgeProps(edge),
        },
      );
    } finally {
      await session.close();
    }
  }

  /** Ego-network of `rootId` up to `depth` hops. Spec §8.2 query 2.
   *  `depth` is interpolated into the Cypher path pattern (parameters aren't
   *  allowed there), so we clamp to [1,4] before substitution to prevent
   *  Cypher injection or runaway traversals. */
  async subgraph(userId: string, rootId: string, depth = 2, limit = 500): Promise<Subgraph> {
    const safeDepth = Math.max(1, Math.min(4, Math.floor(depth)));
    const session = this.driver.session();
    try {
      const result = await session.run(
        `MATCH path = (root:KGNode {id: $rootId, userId: $userId})-[*1..${safeDepth}]-(neighbour:KGNode {userId: $userId})
         WITH collect(distinct neighbour) + collect(distinct root) AS ns,
              collect(distinct relationships(path)) AS rels
         RETURN ns AS nodes, apoc.coll.flatten(rels) AS edges
         LIMIT $limit`,
        { rootId, userId, limit },
      );
      const record = result.records[0];
      if (!record) return { nodes: [], edges: [] };
      return this.mapSubgraph(record);
    } finally {
      await session.close();
    }
  }

  async deleteNode(userId: string, nodeId: string): Promise<boolean> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        `MATCH (n:KGNode {id: $nodeId, userId: $userId})
         SET n.deletedAt = toString(datetime())
         RETURN n`,
        { nodeId, userId },
      );
      return result.records.length > 0;
    } finally {
      await session.close();
    }
  }

  /** GDPR delete (Rule 19): purge every node + edge belonging to a user. */
  async deleteAllForUser(userId: string): Promise<void> {
    const session = this.driver.session();
    try {
      await session.run(
        `MATCH (n:KGNode {userId: $userId}) DETACH DELETE n`,
        { userId },
      );
    } finally {
      await session.close();
    }
  }

  // ── private helpers ──
  private nodeProps(node: KGNode): Record<string, unknown> {
    return {
      id: node.id,
      label: node.label,
      type: node.type,
      sourceId: node.sourceId,
      sourceUrl: node.sourceUrl ?? null,
      createdAt: node.createdAt,
      metadataJson: JSON.stringify(node.metadata ?? {}),
    };
  }

  private edgeProps(edge: KGEdge): Record<string, unknown> {
    return {
      id: edge.id,
      relation: edge.relation,
      weight: edge.weight,
      inferred: edge.inferred,
      createdAt: edge.createdAt,
      metadataJson: JSON.stringify(edge.metadata ?? {}),
    };
  }

  private mapSubgraph(record: Neo4jRecord): Subgraph {
    // TODO(phase-2): map Neo4j record fields back into KGNode/KGEdge with full
    // schema validation. Stubbed to keep Phase 0 lightweight.
    return {
      nodes: (record.get('nodes') ?? []) as KGNode[],
      edges: (record.get('edges') ?? []) as KGEdge[],
    };
  }
}
