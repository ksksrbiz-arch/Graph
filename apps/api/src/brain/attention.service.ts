// Direct the brain to focus on a subgraph for a configurable window. The user
// asks "think about PACER" → resolve the query into a set of neurons, then
// pulse every match at a fixed cadence so the awake stimulus driver lights up
// that region of cortex instead of cycling uniformly through the population.

import { Inject, Injectable, Logger } from '@nestjs/common';
import neo4j, { type Driver } from 'neo4j-driver';
import { NEO4J_DRIVER } from '../shared/neo4j/neo4j.module';
import { BrainService } from './brain.service';

const DEFAULT_DURATION_MS = 30_000;
const DEFAULT_PULSE_MS = 200;
const DEFAULT_PULSE_CURRENT = 22;
const MAX_NEURONS_PER_QUERY = 25;

export interface AttentionFocus {
  userId: string;
  query: string;
  neuronIds: string[];
  startedAt: number;
  durationMs: number;
  pulseMs: number;
  pulseCurrent: number;
  endsAt: number;
}

interface RunningFocus extends AttentionFocus {
  pulseTimer: NodeJS.Timeout;
  endTimer: NodeJS.Timeout;
}

@Injectable()
export class AttentionService {
  private readonly logger = new Logger(AttentionService.name);
  private readonly active = new Map<string, RunningFocus>();

  constructor(
    @Inject(NEO4J_DRIVER) private readonly driver: Driver,
    private readonly brain: BrainService,
  ) {}

  /**
   * Focus the user's brain on neurons matching `query`.
   *
   * Resolution rules (first match wins):
   *  1. `neuron:<uuid>` — exact neuron id
   *  2. `id:<uuid>`     — same as above, alternate prefix
   *  3. plain string    — case-insensitive substring on KGNode.label, top-N by degree
   */
  async focus(
    userId: string,
    query: string,
    opts: { durationMs?: number; pulseMs?: number; pulseCurrent?: number } = {},
  ): Promise<AttentionFocus> {
    this.unfocus(userId);

    const neuronIds = await this.resolve(query);
    if (!neuronIds.length) {
      this.logger.warn(`attention: no neurons match "${query}"`);
      throw new Error(`No neurons matched "${query}"`);
    }

    const durationMs = opts.durationMs ?? DEFAULT_DURATION_MS;
    const pulseMs = opts.pulseMs ?? DEFAULT_PULSE_MS;
    const pulseCurrent = opts.pulseCurrent ?? DEFAULT_PULSE_CURRENT;
    const startedAt = Date.now();
    const focus: AttentionFocus = {
      userId,
      query,
      neuronIds,
      startedAt,
      durationMs,
      pulseMs,
      pulseCurrent,
      endsAt: startedAt + durationMs,
    };

    const pulseTimer = setInterval(() => {
      for (const id of neuronIds) {
        this.brain.stimulate(userId, id, pulseCurrent);
      }
    }, pulseMs);

    const endTimer = setTimeout(() => this.unfocus(userId), durationMs);

    this.active.set(userId, { ...focus, pulseTimer, endTimer });
    this.logger.log(
      `attention: user=${userId} query="${query}" → ${neuronIds.length} neurons for ${durationMs}ms`,
    );
    return focus;
  }

  unfocus(userId: string): boolean {
    const f = this.active.get(userId);
    if (!f) return false;
    clearInterval(f.pulseTimer);
    clearTimeout(f.endTimer);
    this.active.delete(userId);
    this.logger.log(`attention: user=${userId} cleared`);
    return true;
  }

  current(userId: string): AttentionFocus | null {
    const f = this.active.get(userId);
    if (!f) return null;
    return {
      userId: f.userId,
      query: f.query,
      neuronIds: f.neuronIds,
      startedAt: f.startedAt,
      durationMs: f.durationMs,
      pulseMs: f.pulseMs,
      pulseCurrent: f.pulseCurrent,
      endsAt: f.endsAt,
    };
  }

  private async resolve(query: string): Promise<string[]> {
    const m = /^(?:neuron|id):(.+)$/i.exec(query.trim());
    if (m) return [m[1]!];

    const session = this.driver.session();
    try {
      const res = await session.executeRead((tx) =>
        tx.run(
          `MATCH (n:KGNode)
           WHERE n.deletedAt IS NULL AND toLower(n.label) CONTAINS toLower($q)
           RETURN n.id AS id, COUNT { (n)--() } AS deg
           ORDER BY deg DESC
           LIMIT $limit`,
          { q: query, limit: neo4j.int(MAX_NEURONS_PER_QUERY) },
        ),
      );
      return res.records.map((r) => String(r.get('id')));
    } finally {
      await session.close();
    }
  }
}
