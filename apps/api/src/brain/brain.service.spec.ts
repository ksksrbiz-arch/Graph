import type { ConnectomeInput } from '@pkg/spiking';
import { BrainService } from './brain.service';
import type { ConnectomeLoader } from './connectome.loader';

describe('BrainService', () => {
  function makeLoader(c: ConnectomeInput): ConnectomeLoader {
    return {
      loadForUser: jest.fn().mockResolvedValue(c),
      persistWeights: jest.fn().mockResolvedValue(undefined),
    } as unknown as ConnectomeLoader;
  }

  afterEach(() => {
    jest.useRealTimers();
  });

  it('starts a per-user simulator and reports its size', async () => {
    jest.useFakeTimers();
    const svc = new BrainService(
      makeLoader({
        neurons: [{ id: 'a', region: 'sensory' }, { id: 'b', region: 'motor' }],
        synapses: [{ id: 'ab', pre: 'a', post: 'b', weight: 0.6 }],
      }),
    );
    const summary = await svc.start('user-1');
    expect(summary).toEqual({ neurons: 2, synapses: 1 });
    expect(svc.isRunning('user-1')).toBe(true);
    svc.stop('user-1');
    expect(svc.isRunning('user-1')).toBe(false);
  });

  it('publishes spike events to subscribers, scoped to the user that owns them', async () => {
    jest.useFakeTimers();
    const svc = new BrainService(
      makeLoader({
        neurons: [{ id: 'a' }],
        synapses: [],
      }),
    );
    const captured: string[] = [];
    svc.subscribeSpikes((userId, e) => captured.push(`${userId}:${e.neuronId}`));

    await svc.start('user-1');
    // Inject a hard pulse and let the timer tick a few times.
    for (let i = 0; i < 20; i++) {
      svc.stimulate('user-1', 'a', 30);
      jest.advanceTimersByTime(50);
    }
    svc.stop('user-1');

    expect(captured.length).toBeGreaterThan(0);
    expect(captured.every((s) => s.startsWith('user-1:'))).toBe(true);
  });

  it('stop() is idempotent and reports false when nothing was running', () => {
    const svc = new BrainService(makeLoader({ neurons: [], synapses: [] }));
    expect(svc.stop('nobody')).toBe(false);
  });
});
