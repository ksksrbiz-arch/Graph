// Memories from spike co-firings. Pairs of neurons that fire within
// RECALL_WINDOW_MS of each other are tallied with exponential half-life decay;
// pairs above MEMORY_THRESHOLD become queryable "memories" via the API. This
// turns transient cortical activity into something the user can interrogate.

import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import type { SpikeEvent } from '@pkg/spiking';
import { BrainService } from './brain.service';

const RECALL_WINDOW_MS = 200;
const MEMORY_HALF_LIFE_MS = 5 * 60_000;
const MEMORY_THRESHOLD = 4;
const MAX_MEMORIES = 256;

interface PairKey {
  a: string;
  b: string;
  key: string;
}

export interface MemoryRecord {
  a: string;
  b: string;
  count: number;
  lastSeenAt: number;
  strength: number;
}

@Injectable()
export class RecallService {
  private readonly logger = new Logger(RecallService.name);
  /** Per-user pair tally. */
  private readonly tallies = new Map<string, Map<string, MemoryRecord>>();
  /** Per-user sliding window of recent spikes — used to detect co-fires. */
  private readonly recent = new Map<string, Array<{ id: string; t: number }>>();
  /** Per-user listener handle so stop() can detach cleanly. */
  private readonly listeners = new Map<string, (e: SpikeEvent) => void>();

  constructor(
    @Inject(forwardRef(() => BrainService))
    private readonly brain: BrainService,
  ) {}

  start(userId: string): void {
    if (this.tallies.has(userId)) return;
    this.tallies.set(userId, new Map());
    this.recent.set(userId, []);

    const listener = (e: SpikeEvent) => {
      const rec = this.recent.get(userId);
      const tally = this.tallies.get(userId);
      if (!rec || !tally) return;
      const now = Date.now();

      for (let i = rec.length - 1; i >= 0; i--) {
        if (rec[i]!.t < now - RECALL_WINDOW_MS) break;
        if (rec[i]!.id === e.neuronId) continue;
        const key = pairKey(e.neuronId, rec[i]!.id);
        const m = tally.get(key.key) ?? {
          a: key.a,
          b: key.b,
          count: 0,
          lastSeenAt: now,
          strength: 0,
        };
        m.count += 1;
        m.lastSeenAt = now;
        m.strength = m.count;
        tally.set(key.key, m);
      }

      rec.push({ id: e.neuronId, t: now });
      const cutoff = now - RECALL_WINDOW_MS;
      while (rec.length && rec[0]!.t < cutoff) rec.shift();

      if (tally.size > MAX_MEMORIES * 2) this.prune(userId);
    };

    this.listeners.set(userId, listener);
    this.brain.onSpike(userId, listener);
    this.logger.log(`recall: tracking co-firings for user=${userId}`);
  }

  stop(userId: string): void {
    const listener = this.listeners.get(userId);
    if (listener) this.brain.offSpike(userId, listener);
    this.listeners.delete(userId);
    this.tallies.delete(userId);
    this.recent.delete(userId);
  }

  /** Inject a spike directly — bypasses BrainService. Used by tests and for
   *  potential future callers (e.g. a memory replay tool). */
  ingestSpike(userId: string, e: SpikeEvent): void {
    const listener = this.listeners.get(userId);
    listener?.(e);
  }

  /** Return top-N strongest memories that include `neuronId` (or all if not
   *  provided). Strength is recomputed at read time with the current decay. */
  recall(
    userId: string,
    opts: { neuronId?: string; limit?: number } = {},
  ): MemoryRecord[] {
    const tally = this.tallies.get(userId);
    if (!tally) return [];
    const limit = opts.limit ?? 20;
    const now = Date.now();

    let memories = [...tally.values()].map((m) => ({
      ...m,
      strength: m.count * Math.exp(-(now - m.lastSeenAt) / MEMORY_HALF_LIFE_MS),
    }));
    if (opts.neuronId) {
      memories = memories.filter(
        (m) => m.a === opts.neuronId || m.b === opts.neuronId,
      );
    }
    return memories
      .filter((m) => m.count >= MEMORY_THRESHOLD)
      .sort((a, b) => b.strength - a.strength)
      .slice(0, limit);
  }

  private prune(userId: string): void {
    const tally = this.tallies.get(userId);
    if (!tally) return;
    const now = Date.now();
    const all = [...tally.values()].map((m) => ({
      m,
      strength: m.count * Math.exp(-(now - m.lastSeenAt) / MEMORY_HALF_LIFE_MS),
    }));
    all.sort((a, b) => b.strength - a.strength);
    tally.clear();
    for (const { m } of all.slice(0, MAX_MEMORIES)) {
      tally.set(pairKey(m.a, m.b).key, m);
    }
  }
}

function pairKey(a: string, b: string): PairKey {
  const [first, second] = a < b ? [a, b] : [b, a];
  return { a: first!, b: second!, key: `${first}|${second}` };
}
