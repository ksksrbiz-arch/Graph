// Executive cortex. Synthesises a one-sentence conclusion from the memories
// and reasoning paths produced by the upstream phases. No LLM — the conclusion
// is template-based and grounded in the structural signals (path strength,
// memory salience, region distribution) so it's reproducible and auditable.

import type {
  Association,
  CortexNode,
  Thought,
  ThoughtStep,
} from './types.js';

export interface ExecutiveResult {
  conclusion: string;
  /** Confidence in [0, 1] derived from association strength + memory count. */
  confidence: number;
  step: ThoughtStep;
}

/**
 * Compose a conclusion from the structured cognitive evidence. The shape is
 * intentionally readable English so downstream consumers (the SPA, REST
 * clients, or an MCP transcript) can surface it directly.
 */
export function plan(
  question: string,
  seeds: CortexNode[],
  memories: CortexNode[],
  associations: Association[],
): ExecutiveResult {
  if (seeds.length === 0) {
    return {
      conclusion: `I have nothing to anchor on for "${question}" — no seed nodes matched.`,
      confidence: 0,
      step: stepOf('no seeds; cannot conclude'),
    };
  }

  if (memories.length === 0 && associations.length === 0) {
    return {
      conclusion: `I see ${seeds.length} matching node${seeds.length === 1 ? '' : 's'} but nothing in the graph connects to them yet.`,
      confidence: 0.1,
      step: stepOf('seeds present but no memories'),
    };
  }

  const topAssoc = associations[0];
  const topMemory = memories[0];
  const topSeed = seeds[0]!;

  const phrases: string[] = [];
  phrases.push(
    `Anchoring on ${labelOrId(topSeed)}${seeds.length > 1 ? ` (and ${seeds.length - 1} other seed${seeds.length - 1 === 1 ? '' : 's'})` : ''}`,
  );
  if (topAssoc) {
    const memNode = memories.find((m) => m.id === topAssoc.target);
    phrases.push(
      `the strongest connection runs through ${describePath(topAssoc)} to ${memNode ? labelOrId(memNode) : topAssoc.target}`,
    );
  } else if (topMemory) {
    phrases.push(`the most salient memory is ${labelOrId(topMemory)}`);
  }

  const regions = collectRegions(memories);
  if (regions.length > 0) {
    phrases.push(`with activity concentrated in ${regions.slice(0, 3).join(', ')}`);
  }

  const conclusion = `${phrases.join('; ')}.`;

  // Confidence: average association strength weighted by count, plus a memory
  // bonus. Capped at 0.95 — deterministic reasoning never claims certainty.
  const strength = associations.length === 0
    ? 0
    : associations.slice(0, 5).reduce((acc, a) => acc + a.strength, 0) /
      Math.min(5, associations.length);
  const memoryBonus = Math.min(0.4, memories.length * 0.05);
  const confidence = clampUnit(strength * 0.6 + memoryBonus);

  return {
    conclusion,
    confidence,
    step: stepOf(
      `concluded with confidence ${confidence.toFixed(2)} from ${associations.length} paths × ${memories.length} memories`,
    ),
  };
}

function collectRegions(memories: CortexNode[]): string[] {
  const counts = new Map<string, number>();
  for (const m of memories) {
    if (!m.region) continue;
    counts.set(m.region, (counts.get(m.region) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([region, n]) => `${region} (${n})`);
}

function describePath(a: Association): string {
  if (a.steps.length === 0) return '(direct edge)';
  const relations = a.steps.map((s) => s.edge.relation ?? 'REL').join(' → ');
  return `${a.length} hop${a.length === 1 ? '' : 's'} (${relations})`;
}

function labelOrId(n: { id: string; label?: string }): string {
  const label = n.label?.trim();
  if (!label) return n.id;
  return label.length > 60 ? `${label.slice(0, 59)}…` : label;
}

function stepOf(summary: string): ThoughtStep {
  return { phase: 'executive', summary, detail: {} };
}

function clampUnit(x: number): number {
  if (!Number.isFinite(x) || x <= 0) return 0;
  if (x >= 0.95) return 0.95;
  return x;
}

/** Build a complete `Thought` after every other phase has run. Lives here
 *  because the executive cortex is the natural assembler of the trace. */
export function compose(
  question: string,
  seeds: CortexNode[],
  memories: CortexNode[],
  associations: Association[],
  conclusion: string,
  confidence: number,
  trace: ThoughtStep[],
  actions: Thought['actions'],
  elapsedMs: number,
): Thought {
  return {
    question,
    seeds,
    memories,
    associations,
    conclusion,
    actions,
    trace,
    confidence,
    elapsedMs,
  };
}
