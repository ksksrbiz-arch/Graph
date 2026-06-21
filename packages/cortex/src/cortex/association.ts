// Association cortex. Connects seeds to memories via the strongest reasoning
// path through the graph (Dijkstra over -log(weight)) and surfaces likely
// missing edges via Adamic-Adar link prediction. Output is a structured list
// of "this is why these two are related" explanations the executive cortex
// uses to draft a conclusion.

import {
  findReasoningPath,
  predictLinks,
  type LinkPrediction,
  type ReasoningPath,
} from '@pkg/reasoning';
import type {
  Association,
  AssociationStep,
  CortexInput,
  CortexNode,
  ThoughtStep,
} from './types.js';

const DEFAULT_DEPTH = 4;

export interface AssociationResult {
  associations: Association[];
  /** Top predicted-link candidates from each seed, capped at 3 per seed. */
  predictedLinks: Array<LinkPrediction & { seed: string }>;
  step: ThoughtStep;
}

/**
 * For every (seed, memory) pair compute the strongest reasoning path; for
 * every seed compute top-3 predicted links. Both inform the executive cortex.
 *
 * Paths are deduplicated by (source, target) so the same explanation never
 * appears twice. Self-pairs and unreachable pairs are skipped silently.
 */
export function associate(
  input: CortexInput,
  seeds: CortexNode[],
  memories: CortexNode[],
): AssociationResult {
  const maxDepth = input.maxAssociationDepth ?? DEFAULT_DEPTH;
  const seen = new Set<string>();
  const associations: Association[] = [];

  for (const seed of seeds) {
    for (const memory of memories) {
      if (seed.id === memory.id) continue;
      const key = `${seed.id}|${memory.id}`;
      if (seen.has(key)) continue;
      const path = findReasoningPath(input.graph, seed.id, memory.id, { maxDepth });
      if (!path) continue;
      seen.add(key);
      associations.push(toAssociation(path));
    }
  }

  // Strongest paths first so executive can pick the top-N.
  associations.sort((a, b) => b.strength - a.strength);

  const predictedLinks: AssociationResult['predictedLinks'] = [];
  for (const seed of seeds) {
    const links = predictLinks(input.graph, seed.id, { method: 'adamic-adar', limit: 3 });
    for (const link of links) {
      predictedLinks.push({ ...link, seed: seed.id });
    }
  }
  predictedLinks.sort((a, b) => b.score - a.score);

  return {
    associations,
    predictedLinks,
    step: {
      phase: 'association',
      summary:
        associations.length === 0
          ? 'no reasoning paths within max depth'
          : `built ${associations.length} reasoning path${associations.length === 1 ? '' : 's'} (top strength ${round(associations[0]!.strength)})`,
      detail: {
        topAssociations: associations.slice(0, 5).map((a) => ({
          source: a.source,
          target: a.target,
          length: a.length,
          strength: round(a.strength),
        })),
        topPredictedLinks: predictedLinks.slice(0, 5),
      },
    },
  };
}

function toAssociation(path: ReasoningPath): Association {
  const steps: AssociationStep[] = path.steps.map((s) => ({
    from: s.from,
    to: s.to,
    edge: s.edge,
    weight: s.weight,
  }));
  return {
    source: path.source,
    target: path.target,
    steps,
    strength: path.strength,
    length: path.length,
  };
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}
