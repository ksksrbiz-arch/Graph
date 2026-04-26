import { AttentionService } from './attention.service';
import type { BrainService } from './brain.service';

describe('AttentionService', () => {
  function makeFakeDriver(neuronIds: string[]) {
    return {
      session: () => ({
        executeRead: async (
          fn: (tx: { run: (...args: unknown[]) => Promise<unknown> }) => Promise<unknown>,
        ) =>
          fn({
            run: async () => ({
              records: neuronIds.map((id) => ({ get: () => id })),
            }),
          }),
        close: async () => undefined,
      }),
    } as unknown;
  }

  function makeBrain(): BrainService {
    return { stimulate: jest.fn(() => true) } as unknown as BrainService;
  }

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('resolves neuron:<id> directly without hitting Neo4j', async () => {
    const a = new AttentionService(
      makeFakeDriver(['SHOULD_NOT_BE_USED']) as never,
      makeBrain(),
    );
    const f = await a.focus('u1', 'neuron:abc-123');
    expect(f.neuronIds).toEqual(['abc-123']);
    a.unfocus('u1');
  });

  it('pulses every neuron at the configured cadence', async () => {
    const brain = makeBrain();
    const a = new AttentionService(
      makeFakeDriver(['n1', 'n2', 'n3']) as never,
      brain,
    );
    await a.focus('u1', 'pacer', { durationMs: 1000, pulseMs: 200, pulseCurrent: 10 });
    jest.advanceTimersByTime(450);
    // 2 pulses × 3 neurons = 6 stimulations
    expect((brain.stimulate as jest.Mock).mock.calls.length).toBe(6);
    a.unfocus('u1');
  });

  it('auto-clears focus after durationMs', async () => {
    const a = new AttentionService(makeFakeDriver(['n1']) as never, makeBrain());
    await a.focus('u1', 'pacer', { durationMs: 100, pulseMs: 50 });
    expect(a.current('u1')).not.toBeNull();
    jest.advanceTimersByTime(150);
    expect(a.current('u1')).toBeNull();
  });

  it('starting a new focus replaces the old one', async () => {
    const a = new AttentionService(makeFakeDriver(['n1']) as never, makeBrain());
    await a.focus('u1', 'first');
    const f2 = await a.focus('u1', 'second');
    expect(f2.query).toBe('second');
    expect(a.current('u1')?.query).toBe('second');
    a.unfocus('u1');
  });

  it('throws when query matches no neurons', async () => {
    const a = new AttentionService(makeFakeDriver([]) as never, makeBrain());
    await expect(a.focus('u1', 'no-such-thing')).rejects.toThrow(/No neurons matched/);
  });
});
