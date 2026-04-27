import { Inject, Injectable, Logger } from '@nestjs/common';
import neo4j, { type Driver } from 'neo4j-driver';
import { tagNode, type Region, REGION_STYLE } from '@pkg/cortex';
import type { NeuronInit, SynapseInit } from '@pkg/spiking';
import type { KGNode, NodeType } from '@pkg/shared';
import { NEO4J_DRIVER } from '../shared/neo4j/neo4j.module.js';

/**
 * Loads the live connectome for a user from Neo4j. Mirrors the
 * read pattern in graph.repository.ts but optimized for one-shot
 * neuron/synapse list construction (no ego-network framing).
 *
 * Phase-0 multi-tenancy is loose: every KGNode belongs to "the user". Phase 1
 * scopes by `userId` once we partition the graph properly.
 */
@Injectable()
export class ConnectomeLoader {
  private readonly logger = new Logger(ConnectomeLoader.name);

  constructor(@Inject(NEO4J_DRIVER) private readonly driver: Driver) {}

  async loadFor(_userId: string): Promise<{
    neurons: Array<NeuronInit & { region: Region; type: NodeType; label: string }>;
    synapses: SynapseInit[];
  }> {
    const session = this.driver.session();
    try {
      // 1) all live KGNodes
      const nRes = await session.executeRead((tx) =>
        tx.run(
          `MATCH (n:KGNode)
           WHERE n.deletedAt IS NULL
           RETURN n.id AS id, n.type AS type, n.label AS label, n.sourceId AS sourceId`,
        ),
      );
      const neurons = nRes.records.map((r) => {
        const type = r.get('type') as NodeType;
        const sourceId = r.get('sourceId');
        const region = tagNode({ type, sourceId } as KGNode);
        return {
          id: String(r.get('id')),
          label: String(r.get('label') ?? ''),
          type,
          region,
          bias: REGION_STYLE[region].bias,
        };
      });

      // 2) all outgoing relationships between live KGNodes
      const eRes = await session.executeRead((tx) =>
        tx.run(
          `MATCH (a:KGNode)-[r]->(b:KGNode)
           WHERE a.deletedAt IS NULL AND b.deletedAt IS NULL
           RETURN r.id AS id, a.id AS source, b.id AS target,
                  coalesce(r.weight, 0.5) AS weight`,
        ),
      );
      const synapses = eRes.records.map((r) => ({
        id: String(r.get('id') ?? ''),
        source: String(r.get('source')),
        target: String(r.get('target')),
        weight: Number(r.get('weight')) || 0.5,
      }));

      this.logger.log(
        `connectome: ${neurons.length} neurons · ${synapses.length} synapses`,
      );
      return { neurons, synapses };
    } finally {
      await session.close();
    }
  }

  /** Persist learned weights back to Neo4j — call sparingly (expensive). */
  async persistWeights(
    weights: Array<{ id: string; source: string; target: string; weight: number }>,
  ): Promise<void> {
    if (!weights.length) return;
    const session = this.driver.session();
    const BATCH = 500;
    try {
      for (let i = 0; i < weights.length; i += BATCH) {
        const batch = weights.slice(i, i + BATCH);
        await session.executeWrite((tx) =>
          tx.run(
            `UNWIND $rows AS row
             MATCH (a:KGNode {id: row.source})-[r]->(b:KGNode {id: row.target})
             SET r.weight = row.weight`,
            { rows: batch },
          ),
        );
      }
      // suppress unused — driver int helper kept available if we add LIMIT later
      void neo4j.int;
    } finally {
      await session.close();
    }
  }
}
