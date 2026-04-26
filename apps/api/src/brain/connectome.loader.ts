// Pulls the connectome (= every KGNode + KGEdge for a given user) out of
// Neo4j and reshapes it into the simulator's `ConnectomeInput`. This is the
// bridge between the substrate (the knowledge graph) and the spiking layer:
// every node is a neuron, every edge is a synapse, and the v1 edge weight
// (0–1, layout force) is reused as the initial synaptic strength.

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Driver } from 'neo4j-driver';
import { regionForNode } from '@pkg/cortex';
import type { ConnectorId, NodeType } from '@pkg/shared';
import type { ConnectomeInput } from '@pkg/spiking';
import { NEO4J_DRIVER } from '../shared/neo4j/neo4j.module';

@Injectable()
export class ConnectomeLoader {
  private readonly log = new Logger(ConnectomeLoader.name);

  constructor(@Inject(NEO4J_DRIVER) private readonly driver: Driver) {}

  /**
   * Load every neuron (node) and synapse (edge) belonging to `userId`. Soft-
   * deleted nodes (deletedAt set) are excluded.
   */
  async loadForUser(userId: string, limit = 5_000): Promise<ConnectomeInput> {
    const session = this.driver.session();
    try {
      const nodesRes = await session.run(
        `MATCH (n:KGNode {userId: $userId})
         WHERE n.deletedAt IS NULL
         RETURN n.id AS id, n.type AS type, n.sourceId AS sourceId
         LIMIT $limit`,
        { userId, limit },
      );

      const neurons = nodesRes.records.map((r) => {
        const id = r.get('id') as string;
        const type = r.get('type') as NodeType;
        const sourceId = r.get('sourceId') as ConnectorId | null;
        const region = regionForNode({
          type,
          ...(sourceId ? { sourceId } : {}),
        });
        return { id, region };
      });

      const edgesRes = await session.run(
        `MATCH (a:KGNode {userId: $userId})-[r:REL]->(b:KGNode {userId: $userId})
         WHERE a.deletedAt IS NULL AND b.deletedAt IS NULL
         RETURN r.id AS id, a.id AS pre, b.id AS post, r.weight AS weight
         LIMIT $limit`,
        { userId, limit: limit * 4 },
      );

      const synapses = edgesRes.records.map((r) => ({
        id: r.get('id') as string,
        pre: r.get('pre') as string,
        post: r.get('post') as string,
        weight: clampUnit(Number(r.get('weight') ?? 0.3)),
        delayMs: 1,
      }));

      this.log.log(
        `loaded connectome user=${userId} neurons=${neurons.length} synapses=${synapses.length}`,
      );
      return { neurons, synapses };
    } finally {
      await session.close();
    }
  }

  /**
   * Write the latest synaptic weights back to Neo4j so STDP learning survives
   * a service restart. Matches edges by their stable `r.id`, so the caller
   * does not need to know the user that owns them.
   */
  async persistWeights(
    updates: Array<{ id: string; weight: number }>,
  ): Promise<void> {
    if (updates.length === 0) return;
    const session = this.driver.session();
    try {
      await session.run(
        `UNWIND $updates AS u
         MATCH ()-[r:REL {id: u.id}]->()
         SET r.weight = u.weight`,
        { updates },
      );
    } finally {
      await session.close();
    }
  }
}

function clampUnit(x: number): number {
  if (Number.isNaN(x)) return 0.3;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
