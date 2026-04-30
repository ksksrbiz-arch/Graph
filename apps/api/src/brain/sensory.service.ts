// Translates incoming KGNodes into stimulation pulses on the spiking layer.
// Phase 4+ connectors will call `perceive` (or `perceiveBatch`) for every
// freshly-synced node, so the brain reacts to the world instead of running on
// internal stimulus alone. Region tag drives the injected current — sensory
// inputs hit hardest, association/memory get a softer poke so spikes don't
// always cascade straight to executive.

import { Injectable, Logger } from '@nestjs/common';
import { regionForNode, type Region } from '@pkg/cortex';
import type { KGNode } from '@pkg/shared';
import { BrainService } from './brain.service';

export type PerceivableNode = Pick<KGNode, 'id' | 'type' | 'sourceId'>;

const REGION_CURRENT_MV: Record<Region, number> = {
  sensory: 30,
  limbic: 18,
  executive: 22,
  motor: 14,
  association: 12,
  memory: 12,
};

type PerceiveListener = (userId: string, node: PerceivableNode, region: Region) => void;

@Injectable()
export class SensoryService {
  private readonly log = new Logger(SensoryService.name);
  private readonly listeners = new Set<PerceiveListener>();

  constructor(private readonly brain: BrainService) {}

  perceive(userId: string, node: PerceivableNode): void {
    const region = regionForNode({ type: node.type, sourceId: node.sourceId });
    const current = REGION_CURRENT_MV[region];
    this.brain.stimulate(userId, node.id, current);
    this.log.debug(`perceive ${node.id} (${region}) → ${current} mV`);
    for (const fn of this.listeners) {
      try {
        fn(userId, node, region);
      } catch (err) {
        this.log.warn(`perceive listener crashed: ${(err as Error).message}`);
      }
    }
  }

  perceiveBatch(userId: string, nodes: PerceivableNode[]): void {
    for (const n of nodes) this.perceive(userId, n);
  }

  /** Observe every perceive() call. Used by the cerebral stream so the brain
   *  prompts itself to think after fresh data lands. */
  onPerceive(fn: PerceiveListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
