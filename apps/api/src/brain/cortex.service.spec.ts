import type { ReasoningGraph } from '@pkg/reasoning';
import type { AttentionFocus } from './attention.service';
import { CortexService } from './cortex.service';

function makeFakeGraph(): ReasoningGraph {
  return {
    nodes: [
      { id: 'cortex', label: 'Cortex Compositor', type: 'concept' },
      { id: 'jarvis', label: 'JARVIS', type: 'concept' },
      { id: 'spec', label: 'Cortex Plan Spec', type: 'document' },
      { id: 'alice', label: 'Alice', type: 'person' },
      { id: 'island', label: 'Disconnected Island', type: 'note' },
    ],
    edges: [
      { source: 'cortex', target: 'jarvis', weight: 0.9, relation: 'INSPIRED_BY' },
      { source: 'cortex', target: 'spec', weight: 0.95, relation: 'DESCRIBED_IN' },
      { source: 'spec', target: 'alice', weight: 0.7, relation: 'AUTHORED_BY' },
    ],
  };
}

describe('CortexService', () => {
  function build({
    focus,
    memories,
  }: {
    focus?: AttentionFocus | null;
    memories?: Array<{ a: string; b: string; count: number; lastSeenAt: number; strength: number }>;
  } = {}) {
    const repo = {
      loadUserGraph: jest.fn().mockResolvedValue(makeFakeGraph()),
    };
    const brain = {
      stimulate: jest.fn(),
    };
    const recall = {
      recall: jest.fn().mockReturnValue(memories ?? []),
    };
    const attention = {
      current: jest.fn().mockReturnValue(focus ?? null),
      focus: jest.fn().mockResolvedValue({}),
    };
    const insights = {
      regions: jest.fn().mockReturnValue([]),
    };
    const svc = new CortexService(
      repo as unknown as ConstructorParameters<typeof CortexService>[0],
      brain as unknown as ConstructorParameters<typeof CortexService>[1],
      recall as unknown as ConstructorParameters<typeof CortexService>[2],
      attention as unknown as ConstructorParameters<typeof CortexService>[3],
      insights as unknown as ConstructorParameters<typeof CortexService>[4],
    );
    return { svc, repo, brain, recall, attention, insights };
  }

  it('runs the cortex pipeline and returns a structured Thought', async () => {
    const { svc } = build();
    const thought = await svc.think('user-1', { question: 'tell me about Cortex' });
    expect(thought.seeds.length).toBeGreaterThan(0);
    expect(thought.trace.map((t) => t.phase)).toEqual([
      'sensory',
      'memory',
      'limbic',
      'association',
      'executive',
      'motor',
    ]);
    expect(thought.actions.length).toBeGreaterThan(0);
    expect(thought.enacted).toEqual([]);
  });

  it('uses brain attention focus when no question is provided', async () => {
    const focus: AttentionFocus = {
      userId: 'user-1',
      query: 'cortex',
      neuronIds: ['cortex'],
      startedAt: 0,
      durationMs: 30_000,
      pulseMs: 200,
      pulseCurrent: 22,
      endsAt: 30_000,
    };
    const { svc, attention } = build({ focus });
    const thought = await svc.think('user-1');
    expect(attention.current).toHaveBeenCalledWith('user-1');
    expect(thought.seeds.map((s) => s.id)).toContain('cortex');
  });

  it('promotes co-fired pairs from RecallService into the memory list', async () => {
    const focus: AttentionFocus = {
      userId: 'user-1',
      query: 'cortex',
      neuronIds: ['cortex'],
      startedAt: 0,
      durationMs: 30_000,
      pulseMs: 200,
      pulseCurrent: 22,
      endsAt: 30_000,
    };
    const memories = [
      { a: 'cortex', b: 'island', count: 8, lastSeenAt: 1, strength: 8 },
    ];
    const { svc } = build({ focus, memories });
    const thought = await svc.think('user-1', { question: 'cortex' });
    expect(thought.memories.map((m) => m.id)).toContain('island');
  });

  it('enacts attend + stimulate actions when enact=true', async () => {
    const { svc, attention, brain } = build();
    const thought = await svc.think('user-1', {
      question: 'tell me about Cortex',
      enact: true,
    });
    // The compositor proposes at least one stimulate action; it might also
    // emit an attend. Both should have been executed against the brain.
    if (thought.actions.some((a) => a.kind === 'attend')) {
      expect(attention.focus).toHaveBeenCalled();
    }
    expect(brain.stimulate).toHaveBeenCalled();
    expect(thought.enacted.length).toBeGreaterThan(0);
  });

  it('does not enact actions when enact is false or omitted', async () => {
    const { svc, attention, brain } = build();
    const thought = await svc.think('user-1', { question: 'cortex' });
    expect(attention.focus).not.toHaveBeenCalled();
    expect(brain.stimulate).not.toHaveBeenCalled();
    expect(thought.enacted).toEqual([]);
  });

  it('survives missing brain telemetry gracefully', async () => {
    const repo = {
      loadUserGraph: jest.fn().mockResolvedValue(makeFakeGraph()),
    };
    const brain = { stimulate: jest.fn() };
    const recall = {
      recall: jest.fn().mockImplementation(() => {
        throw new Error('not started');
      }),
    };
    const attention = { current: jest.fn().mockReturnValue(null), focus: jest.fn() };
    const insights = {
      regions: jest.fn().mockImplementation(() => {
        throw new Error('boom');
      }),
    };
    const svc = new CortexService(
      repo as unknown as ConstructorParameters<typeof CortexService>[0],
      brain as unknown as ConstructorParameters<typeof CortexService>[1],
      recall as unknown as ConstructorParameters<typeof CortexService>[2],
      attention as unknown as ConstructorParameters<typeof CortexService>[3],
      insights as unknown as ConstructorParameters<typeof CortexService>[4],
    );
    const thought = await svc.think('user-1', { question: 'cortex' });
    expect(thought.conclusion).toMatch(/Anchoring on/);
  });
});
