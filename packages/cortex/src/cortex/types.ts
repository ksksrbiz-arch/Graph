// Shared types for the cognitive cortex modules. The cortex package layers
// thinking primitives on top of `@pkg/reasoning` (graph algorithms) and the
// spiking layer's region taxonomy. Every module here is deterministic and
// pure-data — it accepts a graph snapshot + optional brain telemetry and
// returns structured "thoughts" without any model dependency.

import type { ReasoningEdge, ReasoningGraph, ReasoningNode } from '@pkg/reasoning';
import type { Region } from '../regions.js';

/** Single salient node carried through the cortex pipeline. */
export interface CortexNode extends ReasoningNode {
  /** Functional region tag, when known. Lets the executive bias on type. */
  region?: Region;
  /** Cosine similarity to the current focus, when computed. */
  similarity?: number;
  /** Number of recent spikes observed for this node, when telemetry is wired. */
  recentSpikes?: number;
  /** 0-1 salience after the limbic boost. Higher = more "worth thinking about". */
  salience?: number;
}

/** Brain-side context the cortex can use when scoring nodes. Optional —
 *  reasoning still works on a bare graph if no spiking activity is available. */
export interface BrainState {
  /** Current attention focus (neuron ids). */
  focusIds?: string[];
  /** Recently-co-fired pairs from RecallService (a, b, strength). */
  memories?: Array<{ a: string; b: string; strength: number }>;
  /** Per-node spike counts in some recent window. */
  recentSpikeCounts?: Record<string, number>;
}

export interface CortexInput {
  /** Free-text question the brain is asked to think about. Optional — when
   *  absent, the cortex picks the most-salient focus from `brainState`. */
  question?: string;
  /** Pre-computed embedding of `question`. Callers can supply this when they
   *  already have one to avoid recomputing inside the cortex. */
  questionEmbedding?: number[];
  /** Knowledge graph snapshot. The cortex never persists; it only reads. */
  graph: ReasoningGraph;
  /** Live brain state used by limbic salience + executive planning. */
  brainState?: BrainState;
  /** Region tags per node id. Looked up from `@pkg/cortex/regionForNode` by
   *  the apps/api adapter; passed through here so the cortex package itself
   *  has no concept of NodeType. */
  regionByNodeId?: Record<string, Region>;
  /** Top-K cap for memory recall. Default 8. */
  memoryLimit?: number;
  /** Hop cap for association reasoning. Default 4. */
  maxAssociationDepth?: number;
}

export type ThoughtPhase =
  | 'sensory'
  | 'memory'
  | 'association'
  | 'executive'
  | 'motor'
  | 'limbic';

/** One step in the thought trace — every cortex module emits at least one. */
export interface ThoughtStep {
  phase: ThoughtPhase;
  /** Short, human-readable explanation of what this phase decided. */
  summary: string;
  /** Phase-specific structured output (memories, paths, proposed actions). */
  detail: Record<string, unknown>;
}

/** Proposed action emitted by the motor cortex. Consumers (apps/api,
 *  SafetySupervisor, the SPA) decide whether to actually execute. */
export type CortexAction =
  | { kind: 'attend'; query: string; reason: string }
  | { kind: 'stimulate'; neuronId: string; currentMv: number; reason: string }
  | { kind: 'propose-edge'; source: string; target: string; weight: number; reason: string }
  | { kind: 'investigate'; nodeId: string; reason: string };

export interface Thought {
  /** Free-text question (echoed back) or auto-generated if none was supplied. */
  question: string;
  /** The seed nodes the cortex anchored on (from focus + question recall). */
  seeds: CortexNode[];
  /** Top memories — semantically-similar nodes pulled from the graph. */
  memories: CortexNode[];
  /** Reasoning paths from each seed to each memory (strongest first). */
  associations: Association[];
  /** One-sentence conclusion synthesised by the executive cortex. */
  conclusion: string;
  /** Concrete next-step actions, ordered by salience. */
  actions: CortexAction[];
  /** Per-phase trace, in execution order. */
  trace: ThoughtStep[];
  /** Confidence in [0, 1] — derived from association strength and memory hits. */
  confidence: number;
  /** Wall-clock duration of this think() call. */
  elapsedMs: number;
}

/** Association = a multi-hop reasoning path the cortex found. The shape is a
 *  thin re-export of `@pkg/reasoning`'s ReasoningPath but typed explicitly so
 *  consumers don't need to import from two places. */
export interface AssociationStep {
  from: string;
  to: string;
  edge: ReasoningEdge;
  weight: number;
}

export interface Association {
  /** Seed node id. */
  source: string;
  /** Memory node id the path connects to. */
  target: string;
  /** Hop-by-hop path. */
  steps: AssociationStep[];
  /** Product of edge weights — explanation strength in [0, 1]. */
  strength: number;
  /** Number of hops. */
  length: number;
}
