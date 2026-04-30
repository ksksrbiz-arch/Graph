// Memory cortex. Pulls "memories" — graph nodes most relevant to the seeds —
// out of the connectome by combining three signals:
//   1. Cosine similarity to the question embedding (semantic recall).
//   2. Co-firing tallies from the brain's RecallService (episodic recall).
//   3. Direct edge neighbours of each seed (declarative recall).
//
// Each memory is annotated with the strongest source so downstream phases can
// explain *why* the brain pulled it up.

import { cosineSim, embed } from '@pkg/reasoning';
import type { BrainState, CortexInput, CortexNode, ThoughtStep } from './types.js';

const DEFAULT_LIMIT = 8;
const SIMILARITY_FLOOR = 0.05;
const NEIGHBOUR_BONUS = 0.4;
const COFIRE_BONUS = 0.6;

export interface MemoryResult {
  memories: CortexNode[];
  step: ThoughtStep;
}

interface RankedMemory {
  node: CortexNode;
  /** 0-1 composite score used for ordering. */
  score: number;
  source: 'semantic' | 'neighbour' | 'co-fire' | 'mixed';
}

/**
 * Recall up to `limit` memories given a question embedding and an optional
 * brain telemetry block. The returned list is unique, sorted by score, and
 * never includes the seeds themselves.
 */
export function recall(
  input: CortexInput,
  questionEmbedding: number[],
  seeds: CortexNode[],
  opts: { limit?: number } = {},
): MemoryResult {
  const limit = Math.max(1, opts.limit ?? input.memoryLimit ?? DEFAULT_LIMIT);
  const seedIds = new Set(seeds.map((s) => s.id));
  const scored = new Map<string, RankedMemory>();

  // 1) semantic recall — cosine over labels.
  for (const node of input.graph.nodes) {
    if (seedIds.has(node.id)) continue;
    const text = node.label;
    if (!text) continue;
    const sim = cosineSim(questionEmbedding, embed(text));
    if (sim < SIMILARITY_FLOOR) continue;
    upsert(scored, node.id, () => ({
      node: decorate(node, input, sim),
      score: sim,
      source: 'semantic',
    }));
  }

  // 2) declarative recall — direct neighbours of any seed get a bonus.
  for (const seed of seeds) {
    for (const edge of input.graph.edges) {
      const otherId = edgeOther(edge.source, edge.target, seed.id);
      if (!otherId || seedIds.has(otherId)) continue;
      const node = input.graph.nodes.find((n) => n.id === otherId);
      if (!node) continue;
      const w = clampUnit(edge.weight ?? 0.5);
      upsert(
        scored,
        otherId,
        () => ({
          node: decorate(node, input),
          score: NEIGHBOUR_BONUS * w,
          source: 'neighbour',
        }),
        (existing) => {
          existing.score += NEIGHBOUR_BONUS * w;
          existing.source = existing.source === 'semantic' ? 'mixed' : 'neighbour';
        },
      );
    }
  }

  // 3) episodic recall — pairs that co-fired with the seeds in the brain.
  applyCofire(scored, seeds, input.brainState, input);

  const ranked = [...scored.values()].sort((a, b) => b.score - a.score);
  const top = ranked.slice(0, limit).map((r) => ({
    ...r.node,
    salience: clampUnit(r.score),
  }));

  return {
    memories: top,
    step: {
      phase: 'memory',
      summary:
        top.length === 0
          ? 'no memories above the relevance floor'
          : `recalled ${top.length} memories — ${countBy(ranked.slice(0, limit), 'source')}`,
      detail: {
        sources: ranked.slice(0, limit).map((r) => ({
          id: r.node.id,
          source: r.source,
          score: round(r.score),
        })),
      },
    },
  };
}

function applyCofire(
  scored: Map<string, RankedMemory>,
  seeds: CortexNode[],
  brain: BrainState | undefined,
  input: CortexInput,
): void {
  if (!brain?.memories?.length) return;
  const seedIds = new Set(seeds.map((s) => s.id));
  // Normalise strengths so the bonus stays in a comparable range to semantic.
  const maxStrength = Math.max(1, ...brain.memories.map((m) => m.strength));
  for (const m of brain.memories) {
    const a = seedIds.has(m.a) ? m.b : seedIds.has(m.b) ? m.a : null;
    if (!a) continue;
    if (seedIds.has(a)) continue;
    const node = input.graph.nodes.find((n) => n.id === a);
    if (!node) continue;
    const bonus = COFIRE_BONUS * (m.strength / maxStrength);
    upsert(
      scored,
      a,
      () => ({
        node: decorate(node, input),
        score: bonus,
        source: 'co-fire',
      }),
      (existing) => {
        existing.score += bonus;
        existing.source = existing.source === 'co-fire' ? 'co-fire' : 'mixed';
      },
    );
  }
}

function upsert(
  map: Map<string, RankedMemory>,
  id: string,
  create: () => RankedMemory,
  update?: (existing: RankedMemory) => void,
): void {
  const existing = map.get(id);
  if (existing) {
    update?.(existing);
  } else {
    map.set(id, create());
  }
}

function decorate(
  node: { id: string; label?: string; type?: string },
  input: CortexInput,
  similarity?: number,
): CortexNode {
  const out: CortexNode = { ...node };
  const region = input.regionByNodeId?.[node.id];
  if (region !== undefined) out.region = region;
  const recent = input.brainState?.recentSpikeCounts?.[node.id];
  if (recent !== undefined) out.recentSpikes = recent;
  if (similarity !== undefined) out.similarity = similarity;
  return out;
}

function edgeOther(source: string, target: string, self: string): string | null {
  if (source === self) return target;
  if (target === self) return source;
  return null;
}

function clampUnit(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

function countBy<T extends { source: string }>(rows: T[], key: 'source'): string {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r[key], (counts.get(r[key]) ?? 0) + 1);
  return [...counts.entries()].map(([k, v]) => `${k}=${v}`).join(' ');
}
