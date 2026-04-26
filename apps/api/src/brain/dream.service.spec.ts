import type { SpikeEvent } from '@pkg/spiking';
import type { AttentionService } from './attention.service';
import type { BrainGateway } from './brain.gateway';
import type { BrainService } from './brain.service';
import { DreamService } from './dream.service';

interface FakeBrain {
  service: BrainService;
  stimulate: jest.Mock;
  setStimulationGain: jest.Mock;
  setNoiseGain: jest.Mock;
  emitSpike: (e: SpikeEvent) => void;
}

function makeFakeBrain(): FakeBrain {
  let captured: ((e: SpikeEvent) => void) | null = null;
  const stimulate = jest.fn();
  const setStimulationGain = jest.fn();
  const setNoiseGain = jest.fn();
  const onSpike = jest.fn((_userId: string, fn: (e: SpikeEvent) => void) => {
    captured = fn;
  });
  const offSpike = jest.fn(() => {
    captured = null;
  });
  const service = {
    stimulate,
    setStimulationGain,
    setNoiseGain,
    onSpike,
    offSpike,
  } as unknown as BrainService;
  return {
    service,
    stimulate,
    setStimulationGain,
    setNoiseGain,
    emitSpike: (e) => captured?.(e),
  };
}

function makeFakeGateway(): BrainGateway {
  return { emitDream: jest.fn() } as unknown as BrainGateway;
}

function makeFakeAttention(active = false): AttentionService {
  return {
    current: jest.fn(() => (active ? { query: 'x' } : null)),
  } as unknown as AttentionService;
}

describe('DreamService', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('cycles awake → sleeping → awake', () => {
    const brain = makeFakeBrain();
    const d = new DreamService(brain.service, makeFakeGateway(), makeFakeAttention(false));

    d.start('u1', { awakeMs: 1000, dreamMs: 200 });
    expect(d.status('u1')?.phase).toBe('awake');

    jest.advanceTimersByTime(1001);
    expect(d.status('u1')?.phase).toBe('sleeping');
    expect(brain.setStimulationGain).toHaveBeenCalledWith('u1', 0.1);
    expect(brain.setNoiseGain).toHaveBeenCalledWith('u1', 2.0);

    jest.advanceTimersByTime(201);
    expect(d.status('u1')?.phase).toBe('awake');
    expect(brain.setStimulationGain).toHaveBeenLastCalledWith('u1', 1.0);
    expect(brain.setNoiseGain).toHaveBeenLastCalledWith('u1', 1.0);

    d.stop('u1');
  });

  it('skips sleep if attention is active', () => {
    const brain = makeFakeBrain();
    const d = new DreamService(brain.service, makeFakeGateway(), makeFakeAttention(true));
    d.start('u1', { awakeMs: 100, dreamMs: 100 });
    jest.advanceTimersByTime(150);
    // attention blocked sleep; phase remains 'awake' and no gain change fired
    expect(d.status('u1')?.phase).toBe('awake');
    expect(brain.setStimulationGain).not.toHaveBeenCalled();
    d.stop('u1');
  });

  it('triggerDream forces immediate sleep', () => {
    const brain = makeFakeBrain();
    const d = new DreamService(brain.service, makeFakeGateway(), makeFakeAttention(false));
    d.start('u1', { awakeMs: 999_999, dreamMs: 50 });
    expect(d.status('u1')?.phase).toBe('awake');
    d.triggerDream('u1');
    expect(d.status('u1')?.phase).toBe('sleeping');
    d.stop('u1');
  });

  it('replays only neurons that recently spiked, weighted by frequency', () => {
    const brain = makeFakeBrain();
    const d = new DreamService(brain.service, makeFakeGateway(), makeFakeAttention(false));
    d.start('u1', { awakeMs: 50, dreamMs: 1000 });

    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      brain.emitSpike({ neuronId: 'hot-neuron', tMs: i, v: -50 });
    }
    brain.emitSpike({ neuronId: 'cold-neuron', tMs: now, v: -50 });

    jest.advanceTimersByTime(60);  // enter sleep
    jest.advanceTimersByTime(120); // first replay tick at 100ms

    const targets = brain.stimulate.mock.calls.map((c) => c[1]);
    expect(targets).toContain('hot-neuron');
    // hot-neuron is the more frequent → should appear before cold-neuron
    const hotIdx = targets.indexOf('hot-neuron');
    const coldIdx = targets.indexOf('cold-neuron');
    if (coldIdx >= 0) expect(hotIdx).toBeLessThan(coldIdx);
    d.stop('u1');
  });
});
