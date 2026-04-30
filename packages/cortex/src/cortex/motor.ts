// Motor cortex. Translates the executive's conclusion into concrete next-step
// actions. Each action is a *proposal* — the brain runtime / safety supervisor
// gets the final say on whether to actually execute. Three families of action
// are produced:
//
//   1. attend — refocus the spiking layer on the strongest memory, so the
//      brain physically reverberates around the answer.
//   2. propose-edge — surface high-scoring predicted links so a connector or
//      the user can confirm them.
//   3. investigate — tag isolated/low-strength memories that deserve deeper
//      digging on a future think() call.

import type { LinkPrediction } from '@pkg/reasoning';
import type {
  Association,
  CortexAction,
  CortexNode,
  ThoughtStep,
} from './types.js';

const ATTEND_THRESHOLD = 0.15;
const EDGE_PROPOSAL_THRESHOLD = 0.3;
const STIMULATE_CURRENT_MV = 18;

export interface MotorResult {
  actions: CortexAction[];
  step: ThoughtStep;
}

export function actuate(
  seeds: CortexNode[],
  memories: CortexNode[],
  associations: Association[],
  predictedLinks: Array<LinkPrediction & { seed: string }>,
): MotorResult {
  const actions: CortexAction[] = [];

  // 1) Refocus attention on the highest-strength association memory, if any.
  if (associations.length > 0 && associations[0]!.strength >= ATTEND_THRESHOLD) {
    const top = associations[0]!;
    const memNode = memories.find((m) => m.id === top.target);
    actions.push({
      kind: 'attend',
      query: `id:${top.target}`,
      reason: `strongest reasoning path (strength ${round(top.strength)}) ends at ${labelOrId(memNode ?? { id: top.target })}`,
    });
    actions.push({
      kind: 'stimulate',
      neuronId: top.target,
      currentMv: STIMULATE_CURRENT_MV,
      reason: 'fire the answer-end so the brain physically resonates with it',
    });
  } else if (memories.length > 0) {
    // No strong path — stimulate the most salient memory directly.
    const m = memories[0]!;
    actions.push({
      kind: 'stimulate',
      neuronId: m.id,
      currentMv: STIMULATE_CURRENT_MV,
      reason: `top salient memory (${(m.salience ?? 0).toFixed(2)})`,
    });
  }

  // 2) Surface high-confidence missing edges.
  for (const link of predictedLinks.slice(0, 3)) {
    if (link.score < EDGE_PROPOSAL_THRESHOLD) continue;
    actions.push({
      kind: 'propose-edge',
      source: link.seed,
      target: link.target,
      weight: clampUnit(link.score),
      reason: `Adamic-Adar score ${round(link.score)} via ${link.commonNeighbours} common neighbour${link.commonNeighbours === 1 ? '' : 's'}`,
    });
  }

  // 3) Flag memories that came back with low salience for follow-up.
  for (const m of memories) {
    const salience = m.salience ?? 0;
    if (salience > 0 && salience < 0.15) {
      actions.push({
        kind: 'investigate',
        nodeId: m.id,
        reason: `weak signal (salience ${salience.toFixed(2)}) — worth a closer look`,
      });
    }
  }

  // 4) If we never settled on a target, suggest investigating the top seed.
  if (actions.length === 0 && seeds.length > 0) {
    const seed = seeds[0]!;
    actions.push({
      kind: 'investigate',
      nodeId: seed.id,
      reason: 'no memories or paths surfaced — the seed itself is the only handle',
    });
  }

  return {
    actions,
    step: {
      phase: 'motor',
      summary:
        actions.length === 0
          ? 'no actions to take'
          : `proposed ${actions.length} action${actions.length === 1 ? '' : 's'}: ${countByKind(actions)}`,
      detail: { count: actions.length },
    },
  };
}

function countByKind(actions: CortexAction[]): string {
  const counts = new Map<string, number>();
  for (const a of actions) counts.set(a.kind, (counts.get(a.kind) ?? 0) + 1);
  return [...counts.entries()].map(([k, v]) => `${k}=${v}`).join(' ');
}

function labelOrId(n: { id: string; label?: string }): string {
  const label = n.label?.trim();
  if (!label) return n.id;
  return label.length > 60 ? `${label.slice(0, 59)}…` : label;
}

function clampUnit(x: number): number {
  if (!Number.isFinite(x) || x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}
