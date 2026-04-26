import type { SpikeEvent } from '@pkg/spiking';
import type { BrainService } from './brain.service';
import { RecallService } from './recall.service';

function makeFakeBrain() {
  const onSpike = jest.fn();
  const offSpike = jest.fn();
  return {
    service: { onSpike, offSpike } as unknown as BrainService,
    onSpike,
    offSpike,
  };
}

function spike(neuronId: string): SpikeEvent {
  return { neuronId, tMs: 0, v: -50 };
}

describe('RecallService', () => {
  beforeEach(() => jest.useFakeTimers({ now: 0 }));
  afterEach(() => jest.useRealTimers());

  it('records co-firings within the recall window and surfaces them after threshold', () => {
    const { service: brain } = makeFakeBrain();
    const r = new RecallService(brain);
    r.start('u1');

    // 5 round-trips of A→B within 200ms should easily clear MEMORY_THRESHOLD=4.
    for (let i = 0; i < 5; i++) {
      r.ingestSpike('u1', spike('A'));
      r.ingestSpike('u1', spike('B'));
    }

    const memories = r.recall('u1', { limit: 5 });
    expect(memories.length).toBe(1);
    expect(new Set([memories[0]!.a, memories[0]!.b])).toEqual(new Set(['A', 'B']));
    expect(memories[0]!.count).toBeGreaterThanOrEqual(4);
  });

  it('filters by neuronId when supplied', () => {
    const { service: brain } = makeFakeBrain();
    const r = new RecallService(brain);
    r.start('u1');
    for (let i = 0; i < 5; i++) {
      r.ingestSpike('u1', spike('A'));
      r.ingestSpike('u1', spike('B'));
    }
    // Advance past the recall window so X/Y don't co-fire with A/B.
    jest.advanceTimersByTime(500);
    for (let i = 0; i < 5; i++) {
      r.ingestSpike('u1', spike('X'));
      r.ingestSpike('u1', spike('Y'));
    }

    const aOnly = r.recall('u1', { neuronId: 'A' });
    expect(aOnly.length).toBe(1);
    expect(new Set([aOnly[0]!.a, aOnly[0]!.b])).toEqual(new Set(['A', 'B']));
  });

  it('detaches the spike listener on stop()', () => {
    const fb = makeFakeBrain();
    const r = new RecallService(fb.service);
    r.start('u1');
    expect(fb.onSpike).toHaveBeenCalledTimes(1);
    r.stop('u1');
    expect(fb.offSpike).toHaveBeenCalledTimes(1);
    expect(r.recall('u1')).toEqual([]);
  });
});
