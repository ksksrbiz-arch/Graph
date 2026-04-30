// Limbic cortex. Boosts the salience of memories that the brain "cares" about
// for affective reasons:
//   • social — person/limbic-region nodes get a fixed boost (people matter).
//   • recency — nodes with recent spikes get a boost proportional to spike count.
//   • repetition — nodes participating in recent co-firing memories get a boost.
//
// The boost is multiplicative on the existing salience field so semantic and
// declarative ranks remain dominant — limbic only re-orders ties.

import type { BrainState, CortexNode, ThoughtStep } from './types.js';

const SOCIAL_BOOST = 1.25;
const RECENCY_BOOST_MAX = 1.4;
const COFIRE_BOOST = 1.15;

export interface LimbicResult {
  memories: CortexNode[];
  step: ThoughtStep;
}

/**
 * Re-rank `memories` according to limbic affect. Returns a new array — does
 * not mutate the input. `memories` may be empty.
 */
export function affect(memories: CortexNode[], brain: BrainState | undefined): LimbicResult {
  if (memories.length === 0) {
    return {
      memories: [],
      step: {
        phase: 'limbic',
        summary: 'no memories to weight',
        detail: { applied: 0 },
      },
    };
  }

  const cofireBoosted = collectCofireIds(brain);
  const maxRecent = Math.max(
    1,
    ...Object.values(brain?.recentSpikeCounts ?? {}),
  );

  let socialCount = 0;
  let recencyCount = 0;
  let cofireCount = 0;
  const reweighted = memories.map((m) => {
    const baseline = m.salience ?? 0;
    let boost = 1;
    if (m.region === 'limbic') {
      boost *= SOCIAL_BOOST;
      socialCount += 1;
    }
    const recent = m.recentSpikes ?? brain?.recentSpikeCounts?.[m.id];
    if (recent !== undefined && recent > 0) {
      const factor = 1 + (RECENCY_BOOST_MAX - 1) * Math.min(1, recent / maxRecent);
      boost *= factor;
      recencyCount += 1;
    }
    if (cofireBoosted.has(m.id)) {
      boost *= COFIRE_BOOST;
      cofireCount += 1;
    }
    const next: CortexNode = { ...m, salience: clampUnit(baseline * boost) };
    if (recent !== undefined && next.recentSpikes === undefined) {
      next.recentSpikes = recent;
    }
    return next;
  });

  reweighted.sort((a, b) => (b.salience ?? 0) - (a.salience ?? 0));

  return {
    memories: reweighted,
    step: {
      phase: 'limbic',
      summary: `boosted social=${socialCount} recency=${recencyCount} co-fire=${cofireCount}`,
      detail: { socialCount, recencyCount, cofireCount },
    },
  };
}

function collectCofireIds(brain: BrainState | undefined): Set<string> {
  const out = new Set<string>();
  for (const m of brain?.memories ?? []) {
    out.add(m.a);
    out.add(m.b);
  }
  return out;
}

function clampUnit(x: number): number {
  if (!Number.isFinite(x) || x <= 0) return 0;
  if (x > 1) return 1;
  return x;
}
