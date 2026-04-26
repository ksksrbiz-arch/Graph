// Behaviour tests for InsightsService. The fake BrainService below stands in
// for the real one — we only exercise the publish surface (subscribeSpikes /
// subscribeWeights / isRunning), so a hand-rolled fake keeps the test
// dependency-free.

import { InsightsService } from './insights.service';
import type { BrainService } from './brain.service';
import type { SpikeEvent, WeightChangeEvent } from '@pkg/spiking';

interface FakeBrain {
  service: BrainService;
  emitSpike: (userId: string, e: SpikeEvent) => void;
  emitWeight: (userId: string, e: WeightChangeEvent) => void;
}

function makeFakeBrain(): FakeBrain {
  const spikeListeners = new Set<(userId: string, e: SpikeEvent) => void>();
  const weightListeners = new Set<(userId: string, e: WeightChangeEvent) => void>();
  const stub = {
    isRunning: () => true,
    subscribeSpikes(fn: (userId: string, e: SpikeEvent) => void): () => void {
      spikeListeners.add(fn);
      return () => spikeListeners.delete(fn);
    },
    subscribeWeights(fn: (userId: string, e: WeightChangeEvent) => void): () => void {
      weightListeners.add(fn);
      return () => weightListeners.delete(fn);
    },
  } as unknown as BrainService;
  return {
    service: stub,
    emitSpike: (userId, e) => {
      for (const fn of spikeListeners) fn(userId, e);
    },
    emitWeight: (userId, e) => {
      for (const fn of weightListeners) fn(userId, e);
    },
  };
}

describe('InsightsService', () => {
  let brain: FakeBrain;
  let insights: InsightsService;

  beforeEach(() => {
    brain = makeFakeBrain();
    insights = new InsightsService(brain.service);
    insights.onModuleInit();
  });

  afterEach(() => {
    insights.onModuleDestroy();
  });

  it('aggregates spikes into a region histogram', () => {
    brain.emitSpike('u1', { neuronId: 'n1', tMs: 1, v: 0, region: 'sensory' });
    brain.emitSpike('u1', { neuronId: 'n2', tMs: 2, v: 0, region: 'memory' });
    brain.emitSpike('u1', { neuronId: 'n3', tMs: 3, v: 0, region: 'sensory' });
    const regions = insights.regions('u1');
    const sensory = regions.find((r) => r.region === 'sensory');
    const memory = regions.find((r) => r.region === 'memory');
    expect(sensory?.count).toBe(2);
    expect(memory?.count).toBe(1);
    expect(sensory?.rate).toBeGreaterThan(0);
  });

  it('tracks weight changes and emits a formation event when crossing the threshold', () => {
    const formed: Array<{ userId: string; synapseId: string }> = [];
    insights.onFormation((userId, e) =>
      formed.push({ userId, synapseId: e.synapseId }),
    );

    // Below threshold — no formation.
    brain.emitWeight('u1', {
      synapseId: 's1',
      pre: 'a',
      post: 'b',
      weight: 0.4,
      delta: 0.1,
      tMs: 1,
    });
    expect(formed).toHaveLength(0);

    // Crossing 0.55 — formation event fires once.
    brain.emitWeight('u1', {
      synapseId: 's1',
      pre: 'a',
      post: 'b',
      weight: 0.6,
      delta: 0.2,
      tMs: 2,
    });
    expect(formed).toEqual([{ userId: 'u1', synapseId: 's1' }]);

    // Wobbling around the threshold doesn't re-fire.
    brain.emitWeight('u1', {
      synapseId: 's1',
      pre: 'a',
      post: 'b',
      weight: 0.7,
      delta: 0.1,
      tMs: 3,
    });
    expect(formed).toHaveLength(1);
  });

  it('summary() ranks pathways by weight and signed delta', () => {
    brain.emitWeight('u1', {
      synapseId: 's1',
      pre: 'a',
      post: 'b',
      weight: 0.8,
      delta: 0.3,
      tMs: 1,
    });
    brain.emitWeight('u1', {
      synapseId: 's2',
      pre: 'a',
      post: 'c',
      weight: 0.5,
      delta: -0.2,
      tMs: 2,
    });

    const summary = insights.summary('u1', { topN: 5 });
    expect(summary.strongestPathways[0]?.synapseId).toBe('s1');
    expect(summary.growingPathways[0]?.synapseId).toBe('s1');
    expect(summary.decayingPathways[0]?.synapseId).toBe('s2');
    expect(summary.running).toBe(true);
  });
});
