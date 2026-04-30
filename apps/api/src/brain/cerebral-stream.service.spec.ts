import type { AttentionService, AttentionFocus } from './attention.service';
import type { BrainGateway, DreamEvt } from './brain.gateway';
import { CerebralStreamService, type CerebralThoughtEvent } from './cerebral-stream.service';
import type { CortexService, CortexThinkResult } from './cortex.service';
import type { InsightsService } from './insights.service';
import type { SensoryService, PerceivableNode } from './sensory.service';

interface Hooks {
  fireFormation?: (userId: string, evt: { synapseId: string; pre: string; post: string; weight: number; formedAt: string }) => void;
  firePerceive?: (userId: string, node: PerceivableNode) => void;
  fireFocus?: (focus: AttentionFocus) => void;
  fireDream?: (userId: string, evt: DreamEvt) => void;
}

function fakeThought(question = 'q'): CortexThinkResult {
  return {
    question,
    seeds: [{ id: 'seed', label: 'Seed' }],
    memories: [{ id: 'mem', label: 'Memory' }],
    associations: [],
    conclusion: 'concluded',
    actions: [],
    trace: [],
    confidence: 0.42,
    elapsedMs: 1,
    enacted: [],
  };
}

function build(hooks: Hooks = {}, options = {}) {
  const cortex = {
    think: jest.fn().mockImplementation((_userId: string, opts: { question?: string } = {}) =>
      Promise.resolve(fakeThought(opts.question)),
    ),
  } as unknown as CortexService;

  const insights = {
    onFormation: jest.fn().mockImplementation((fn: (uid: string, e: { synapseId: string; pre: string; post: string; weight: number; formedAt: string }) => void) => {
      hooks.fireFormation = fn;
      return jest.fn();
    }),
  } as unknown as InsightsService;

  const sensory = {
    onPerceive: jest.fn().mockImplementation((fn: (uid: string, n: PerceivableNode) => void) => {
      hooks.firePerceive = fn;
      return jest.fn();
    }),
  } as unknown as SensoryService;

  const attention = {
    onFocus: jest.fn().mockImplementation((fn: (focus: AttentionFocus) => void) => {
      hooks.fireFocus = fn;
      return jest.fn();
    }),
  } as unknown as AttentionService;

  const gateway = {
    onDream: jest.fn().mockImplementation((fn: (uid: string, e: DreamEvt) => void) => {
      hooks.fireDream = fn;
      return jest.fn();
    }),
    emitThought: jest.fn(),
  } as unknown as BrainGateway;

  const svc = new CerebralStreamService(
    cortex,
    insights,
    sensory,
    attention,
    gateway,
    options,
  );
  svc.onModuleInit();
  return { svc, cortex, gateway };
}

describe('CerebralStreamService', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('triggers a cortex pass on pathway formation and emits the thought', async () => {
    const hooks: Hooks = {};
    const { svc, cortex, gateway } = build(hooks, { minIntervalMs: 0 });

    const captured: CerebralThoughtEvent[] = [];
    svc.subscribe((e) => captured.push(e));

    hooks.fireFormation!('u1', {
      synapseId: 'syn-1',
      pre: 'a',
      post: 'b',
      weight: 0.6,
      formedAt: new Date().toISOString(),
    });

    await jest.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(cortex.think).toHaveBeenCalledTimes(1);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.trigger).toBe('formation');
    expect(captured[0]!.thought.question).toMatch(/connect/);
    expect(gateway.emitThought).toHaveBeenCalledWith('u1', expect.objectContaining({
      trigger: 'formation',
    }));

    svc.onModuleDestroy();
  });

  it('debounces a perceive burst into a single cortex pass', async () => {
    const hooks: Hooks = {};
    const { svc, cortex } = build(hooks, {
      minIntervalMs: 0,
      perceiveBurst: 100, // never reach burst — rely on debounce
      perceiveDebounceMs: 50,
    });

    for (let i = 0; i < 4; i++) {
      hooks.firePerceive!('u1', { id: `n${i}`, type: 'note', sourceId: 'gmail' });
    }

    expect(cortex.think).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(60);
    await Promise.resolve();
    await Promise.resolve();

    expect(cortex.think).toHaveBeenCalledTimes(1);
    svc.onModuleDestroy();
  });

  it('flushes immediately when the perceive burst threshold is hit', async () => {
    const hooks: Hooks = {};
    const { svc, cortex } = build(hooks, {
      minIntervalMs: 0,
      perceiveBurst: 3,
      perceiveDebounceMs: 10_000,
    });

    for (let i = 0; i < 3; i++) {
      hooks.firePerceive!('u1', { id: `n${i}`, type: 'note', sourceId: 'gmail' });
    }

    await jest.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(cortex.think).toHaveBeenCalledTimes(1);
    svc.onModuleDestroy();
  });

  it('uses the focus query as the cortex question when attention fires', async () => {
    const hooks: Hooks = {};
    const { svc, cortex } = build(hooks, { minIntervalMs: 0 });

    hooks.fireFocus!({
      userId: 'u1',
      query: 'cortex deep dive',
      neuronIds: ['cortex'],
      startedAt: 0,
      durationMs: 30_000,
      pulseMs: 200,
      pulseCurrent: 22,
      endsAt: 30_000,
    });

    await jest.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(cortex.think).toHaveBeenCalledWith('u1', expect.objectContaining({
      question: 'cortex deep dive',
    }));
    svc.onModuleDestroy();
  });

  it('triggers a consolidation pass when the dream phase transitions to sleeping', async () => {
    const hooks: Hooks = {};
    const { svc, cortex } = build(hooks, { minIntervalMs: 0 });

    hooks.fireDream!('u1', { phase: 'sleeping', endsAt: Date.now() + 1000, replayCount: 5 });

    await jest.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(cortex.think).toHaveBeenCalled();
    svc.onModuleDestroy();
  });

  it('skips the cortex when the dream phase is not sleeping', async () => {
    const hooks: Hooks = {};
    const { svc, cortex } = build(hooks, { minIntervalMs: 0 });

    hooks.fireDream!('u1', { phase: 'awake', endsAt: Date.now() + 1000, replayCount: 0 });

    await jest.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    expect(cortex.think).not.toHaveBeenCalled();
    svc.onModuleDestroy();
  });

  it('rate-limits rapid triggers with the configured min interval', async () => {
    const hooks: Hooks = {};
    const { svc, cortex } = build(hooks, { minIntervalMs: 1_000 });

    hooks.fireFormation!('u1', {
      synapseId: 's1', pre: 'a', post: 'b', weight: 0.6, formedAt: new Date().toISOString(),
    });
    hooks.fireFormation!('u1', {
      synapseId: 's2', pre: 'c', post: 'd', weight: 0.7, formedAt: new Date().toISOString(),
    });

    await jest.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(cortex.think).toHaveBeenCalledTimes(1);

    // A new trigger arrives during the cooldown — it should be queued, not run yet.
    hooks.fireFormation!('u1', {
      synapseId: 's3', pre: 'e', post: 'f', weight: 0.8, formedAt: new Date().toISOString(),
    });
    await jest.advanceTimersByTimeAsync(500);
    await Promise.resolve();
    expect(cortex.think).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(600);
    await Promise.resolve();
    await Promise.resolve();
    expect(cortex.think).toHaveBeenCalledTimes(2);
    svc.onModuleDestroy();
  });

  it('exposes recent thoughts via recent()', async () => {
    const hooks: Hooks = {};
    const { svc } = build(hooks, { minIntervalMs: 0 });

    hooks.fireFormation!('u1', {
      synapseId: 's', pre: 'a', post: 'b', weight: 0.6, formedAt: new Date().toISOString(),
    });
    await jest.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(svc.recent('u1')).toHaveLength(1);
    expect(svc.recent('u1')[0]!.trigger).toBe('formation');
    svc.onModuleDestroy();
  });

  it('fire() bypasses the rate limiter and runs immediately', async () => {
    const hooks: Hooks = {};
    const { svc, cortex } = build(hooks, { minIntervalMs: 60_000 });

    const result = await svc.fire('u1', 'attention', 'manual');
    expect(result).not.toBeNull();
    expect(cortex.think).toHaveBeenCalledTimes(1);

    const second = await svc.fire('u1', 'attention', 'again');
    expect(second).not.toBeNull();
    expect(cortex.think).toHaveBeenCalledTimes(2);
    svc.onModuleDestroy();
  });
});
