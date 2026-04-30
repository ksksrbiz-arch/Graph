// Sensory cortex. Encodes the inbound question (or a synthesised one) into the
// embedding space and resolves seed nodes the rest of the pipeline will anchor
// on. "Seeds" are the nodes the brain decides are most relevant to the input —
// they come from explicit attention focus, exact label matches, or top-k
// embedding similarity, in that priority order.

import { embed, type ReasoningGraph } from '@pkg/reasoning';
import type { CortexInput, CortexNode, ThoughtStep } from './types.js';

const DEFAULT_SEED_LIMIT = 5;
const SEED_FOCUS_PREFIX = 'focus';
const SEED_LABEL_PREFIX = 'label';
const SEED_VECTOR_PREFIX = 'vector';

export interface SensoryResult {
  /** Echoed question (auto-generated when none was supplied). */
  question: string;
  /** Embedding of the question — passed downstream so memory.recall reuses it. */
  questionEmbedding: number[];
  /** Seed nodes the brain decided to anchor on. */
  seeds: CortexNode[];
  step: ThoughtStep;
}

/**
 * Resolve seed nodes from `input`. Priority:
 *   1. Explicit attention focus from BrainState.focusIds (max `seedLimit`).
 *   2. Exact case-insensitive label matches against the question.
 *   3. Top-K cosine similarity over `embed(node.label)`.
 *
 * The function is fully deterministic — the same input always gives the same
 * seeds, which keeps the rest of the pipeline reproducible for tests.
 */
export function perceive(
  input: CortexInput,
  opts: { seedLimit?: number } = {},
): SensoryResult {
  const seedLimit = Math.max(1, opts.seedLimit ?? DEFAULT_SEED_LIMIT);
  const question = (input.question?.trim() || autoQuestion(input)).slice(0, 500);
  const embedding = input.questionEmbedding ?? embed(question);

  const focused = collectFocus(input, seedLimit);
  if (focused.length >= seedLimit) {
    return finish(question, embedding, focused.slice(0, seedLimit), SEED_FOCUS_PREFIX);
  }

  const remaining = seedLimit - focused.length;
  const labelMatches = collectLabelMatches(input.graph, question, remaining);
  const labelDeduped = dedupe([...focused, ...labelMatches], seedLimit);
  if (labelDeduped.length >= seedLimit || labelMatches.length > 0) {
    return finish(question, embedding, labelDeduped, mixedPrefix(focused.length, labelMatches.length, 0));
  }

  // Fall back to embedding similarity over labelled nodes.
  const stillNeeded = seedLimit - labelDeduped.length;
  const vectorMatches = topByCosine(input.graph, embedding, stillNeeded);
  const finalSeeds = dedupe([...labelDeduped, ...vectorMatches], seedLimit);
  return finish(
    question,
    embedding,
    finalSeeds,
    mixedPrefix(focused.length, labelMatches.length, vectorMatches.length),
  );
}

function finish(
  question: string,
  embedding: number[],
  seeds: CortexNode[],
  source: string,
): SensoryResult {
  return {
    question,
    questionEmbedding: embedding,
    seeds,
    step: {
      phase: 'sensory',
      summary:
        seeds.length === 0
          ? `no seed could be resolved for "${truncate(question, 60)}"`
          : `picked ${seeds.length} seed${seeds.length === 1 ? '' : 's'} via ${source}: ${seeds.map((s) => labelOf(s)).join(', ')}`,
      detail: {
        question,
        seedSource: source,
        seedIds: seeds.map((s) => s.id),
      },
    },
  };
}

function collectFocus(input: CortexInput, limit: number): CortexNode[] {
  const ids = input.brainState?.focusIds ?? [];
  if (ids.length === 0) return [];
  const out: CortexNode[] = [];
  for (const id of ids.slice(0, limit)) {
    const node = input.graph.nodes.find((n) => n.id === id);
    if (!node) continue;
    out.push(decorate(node, input));
  }
  return out;
}

function collectLabelMatches(
  graph: ReasoningGraph,
  question: string,
  limit: number,
): CortexNode[] {
  if (limit <= 0 || question.length === 0) return [];
  const needle = question.toLowerCase();
  const tokens = needle
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length >= 3);
  const hits: Array<{ node: CortexNode; score: number }> = [];
  for (const n of graph.nodes) {
    const label = (n.label ?? '').toLowerCase();
    if (label.length === 0) continue;
    let score = 0;
    if (label === needle) score += 5;
    if (label.includes(needle)) score += 2;
    for (const tok of tokens) {
      if (label.includes(tok)) score += 1;
    }
    if (score > 0) hits.push({ node: { ...n }, score });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit).map((h) => h.node);
}

function topByCosine(
  graph: ReasoningGraph,
  qEmbedding: number[],
  limit: number,
): CortexNode[] {
  if (limit <= 0) return [];
  const scored: Array<{ node: CortexNode; sim: number }> = [];
  for (const n of graph.nodes) {
    const text = n.label;
    if (!text || text.length === 0) continue;
    const sim = cosineDot(qEmbedding, embed(text));
    if (sim <= 0) continue;
    scored.push({ node: { ...n, similarity: sim }, sim });
  }
  scored.sort((a, b) => b.sim - a.sim);
  return scored.slice(0, limit).map((s) => s.node);
}

function dedupe(nodes: CortexNode[], cap: number): CortexNode[] {
  const seen = new Set<string>();
  const out: CortexNode[] = [];
  for (const n of nodes) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    out.push(n);
    if (out.length >= cap) break;
  }
  return out;
}

function decorate(node: { id: string; label?: string; type?: string }, input: CortexInput): CortexNode {
  const region = input.regionByNodeId?.[node.id];
  const recent = input.brainState?.recentSpikeCounts?.[node.id];
  const out: CortexNode = { ...node };
  if (region !== undefined) out.region = region;
  if (recent !== undefined) out.recentSpikes = recent;
  return out;
}

function autoQuestion(input: CortexInput): string {
  const focus = input.brainState?.focusIds?.[0];
  if (focus) {
    const node = input.graph.nodes.find((n) => n.id === focus);
    if (node?.label) return `What is ${node.label}?`;
  }
  // Fall back to the most-spiked node label if available.
  const counts = input.brainState?.recentSpikeCounts ?? {};
  const topId = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
  if (topId) {
    const node = input.graph.nodes.find((n) => n.id === topId);
    if (node?.label) return `What is happening around ${node.label}?`;
  }
  return 'What should I think about right now?';
}

function mixedPrefix(focus: number, label: number, vector: number): string {
  const parts: string[] = [];
  if (focus > 0) parts.push(`${SEED_FOCUS_PREFIX}(${focus})`);
  if (label > 0) parts.push(`${SEED_LABEL_PREFIX}(${label})`);
  if (vector > 0) parts.push(`${SEED_VECTOR_PREFIX}(${vector})`);
  return parts.length === 0 ? 'none' : parts.join('+');
}

function cosineDot(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function labelOf(n: CortexNode): string {
  return truncate(n.label ?? n.id, 32);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
