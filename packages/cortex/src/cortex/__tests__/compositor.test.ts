import { describe, expect, it } from 'vitest';
import type { ReasoningGraph } from '@pkg/reasoning';
import {
  affect,
  associate,
  perceive,
  plan,
  recall,
  think,
} from '../compositor.js';
import type { BrainState, CortexInput } from '../types.js';

// A small but non-trivial graph: two clusters joined by a bridge node so
// reasoning paths and link prediction have something interesting to chew on.
const graph: ReasoningGraph = {
  nodes: [
    { id: 'wayland', label: 'Wayland Compositor', type: 'concept' },
    { id: 'jarvis', label: 'JARVIS Reasoning Loop', type: 'concept' },
    { id: 'cortex', label: 'Cortex Compositor', type: 'concept' },
    { id: 'spec', label: 'Cortex Plan Spec', type: 'document' },
    { id: 'alice', label: 'Alice Engineer', type: 'person' },
    { id: 'bob', label: 'Bob Researcher', type: 'person' },
    { id: 'island', label: 'Unrelated Island', type: 'note' },
  ],
  edges: [
    { source: 'wayland', target: 'cortex', weight: 0.85, relation: 'INSPIRES' },
    { source: 'jarvis', target: 'cortex', weight: 0.9, relation: 'INSPIRES' },
    { source: 'cortex', target: 'spec', weight: 0.95, relation: 'DESCRIBED_IN' },
    { source: 'spec', target: 'alice', weight: 0.7, relation: 'AUTHORED_BY' },
    { source: 'alice', target: 'bob', weight: 0.6, relation: 'WORKS_WITH' },
    { source: 'bob', target: 'jarvis', weight: 0.55, relation: 'STUDIES' },
  ],
};

const regions: Record<string, 'sensory' | 'memory' | 'association' | 'limbic'> = {
  alice: 'limbic',
  bob: 'limbic',
  spec: 'memory',
  wayland: 'association',
  jarvis: 'association',
  cortex: 'association',
};

const baseInput: CortexInput = {
  question: 'How does the Cortex Compositor relate to JARVIS?',
  graph,
  regionByNodeId: regions,
};

describe('cortex compositor', () => {
  it('produces a structured Thought end-to-end', () => {
    const thought = think(baseInput);

    expect(thought.question).toContain('Cortex');
    expect(thought.seeds.length).toBeGreaterThan(0);
    expect(thought.memories.length).toBeGreaterThan(0);
    expect(thought.associations.length).toBeGreaterThan(0);
    expect(thought.conclusion).toMatch(/Anchoring on/);
    expect(thought.actions.length).toBeGreaterThan(0);
    expect(thought.confidence).toBeGreaterThan(0);
    expect(thought.confidence).toBeLessThanOrEqual(0.95);
    expect(thought.trace.map((t) => t.phase)).toEqual([
      'sensory',
      'memory',
      'limbic',
      'association',
      'executive',
      'motor',
    ]);
  });

  it('chains seeds to memories through reasoning paths', () => {
    const thought = think(baseInput);
    const idsTouched = new Set<string>();
    for (const a of thought.associations) {
      idsTouched.add(a.source);
      idsTouched.add(a.target);
    }
    expect(idsTouched.has('cortex') || idsTouched.has('jarvis')).toBe(true);
  });

  it('honours brain attention focus when picking seeds', () => {
    const focused = think({
      ...baseInput,
      question: 'unrelated question text',
      brainState: { focusIds: ['cortex'] },
    });
    expect(focused.seeds.map((s) => s.id)).toContain('cortex');
  });

  it('emits an attend action and at least one stimulate action', () => {
    const thought = think(baseInput);
    const kinds = new Set(thought.actions.map((a) => a.kind));
    expect(kinds.has('attend')).toBe(true);
    expect(kinds.has('stimulate')).toBe(true);
  });
});

describe('cortex.perceive', () => {
  it('falls back to label matching when no focus is supplied', () => {
    const result = perceive({
      graph,
      question: 'jarvis',
    });
    expect(result.seeds.map((s) => s.id)).toContain('jarvis');
    expect(result.step.detail.seedSource).toContain('label');
  });

  it('uses embedding similarity when label match fails', () => {
    const result = perceive({
      graph,
      question: 'compositor',
    });
    expect(result.seeds.length).toBeGreaterThan(0);
    expect(['label(1)', 'label(2)', 'label(3)', 'label(4)', 'label(5)']).toContain(
      result.step.detail.seedSource,
    );
  });

  it('synthesises a question when none is provided and no focus exists', () => {
    const result = perceive({ graph });
    expect(result.question.length).toBeGreaterThan(0);
  });

  it('synthesises a question from focus when no question is given', () => {
    const result = perceive({
      graph,
      brainState: { focusIds: ['cortex'] },
    });
    expect(result.question).toContain('Cortex Compositor');
  });
});

describe('cortex.recall', () => {
  it('returns at most `limit` memories', () => {
    const sensory = perceive(baseInput);
    const result = recall(baseInput, sensory.questionEmbedding, sensory.seeds, {
      limit: 3,
    });
    expect(result.memories.length).toBeLessThanOrEqual(3);
  });

  it('annotates every memory with a salience score', () => {
    const sensory = perceive(baseInput);
    const result = recall(baseInput, sensory.questionEmbedding, sensory.seeds);
    for (const m of result.memories) {
      expect(m.salience).toBeDefined();
      expect(m.salience!).toBeGreaterThan(0);
      expect(m.salience!).toBeLessThanOrEqual(1);
    }
  });

  it('promotes co-fired pairs from BrainState memories', () => {
    const brainState: BrainState = {
      focusIds: ['cortex'],
      memories: [
        { a: 'cortex', b: 'island', strength: 50 },
      ],
    };
    const focusedInput: CortexInput = {
      ...baseInput,
      // A focus-only question avoids label-matching `island` via the word
      // "relate" inside "Unrelated", which would otherwise promote island
      // into the seed set instead of the memory set.
      question: 'cortex deep dive',
      brainState,
    };
    const sensory = perceive(focusedInput);
    const result = recall(focusedInput, sensory.questionEmbedding, sensory.seeds);
    const ids = result.memories.map((m) => m.id);
    expect(ids).toContain('island');
  });
});

describe('cortex.affect (limbic)', () => {
  it('is a no-op with empty memories', () => {
    const result = affect([], undefined);
    expect(result.memories).toEqual([]);
    expect(result.step.detail.applied).toBe(0);
  });

  it('boosts limbic-region nodes ahead of plain memory nodes when salience ties', () => {
    const result = affect(
      [
        { id: 'alice', label: 'Alice', region: 'limbic', salience: 0.5 },
        { id: 'spec', label: 'Spec', region: 'memory', salience: 0.5 },
      ],
      undefined,
    );
    expect(result.memories[0]!.id).toBe('alice');
  });

  it('preserves existing salience when no boost applies', () => {
    const result = affect(
      [{ id: 'spec', label: 'Spec', region: 'memory', salience: 0.7 }],
      undefined,
    );
    expect(result.memories[0]!.salience).toBeCloseTo(0.7, 5);
  });
});

describe('cortex.associate', () => {
  it('finds reasoning paths between distinct seeds and memories', () => {
    const seeds = [{ id: 'cortex', label: 'Cortex Compositor' }];
    const memories = [{ id: 'bob', label: 'Bob Researcher' }];
    const result = associate({ graph }, seeds, memories);
    expect(result.associations.length).toBeGreaterThan(0);
    expect(result.associations[0]!.source).toBe('cortex');
    expect(result.associations[0]!.target).toBe('bob');
    expect(result.associations[0]!.length).toBeGreaterThan(0);
  });

  it('skips self-pairs and unreachable nodes', () => {
    const seeds = [{ id: 'cortex', label: 'Cortex Compositor' }];
    const memories = [
      { id: 'cortex', label: 'self' },
      { id: 'island', label: 'unreachable' },
    ];
    const result = associate({ graph }, seeds, memories);
    expect(result.associations).toEqual([]);
  });
});

describe('cortex.plan (executive)', () => {
  it('reports zero confidence when there are no seeds', () => {
    const result = plan('q', [], [], []);
    expect(result.confidence).toBe(0);
    expect(result.conclusion).toMatch(/nothing to anchor/);
  });

  it('produces low but non-zero confidence when seeds exist but memories don\'t', () => {
    const result = plan('q', [{ id: 'cortex', label: 'Cortex' }], [], []);
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThan(0.3);
  });

  it('caps confidence below 1', () => {
    const seeds = [{ id: 'cortex', label: 'Cortex' }];
    const memories = Array.from({ length: 20 }, (_, i) => ({
      id: `m${i}`,
      label: `m${i}`,
    }));
    const associations = Array.from({ length: 5 }, () => ({
      source: 'cortex',
      target: 'm0',
      steps: [],
      strength: 1,
      length: 1,
    }));
    const result = plan('q', seeds, memories, associations);
    expect(result.confidence).toBeLessThanOrEqual(0.95);
  });
});
