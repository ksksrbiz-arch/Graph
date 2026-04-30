// Cortex service. Glue between the per-user knowledge graph (Neo4j), the
// running spiking brain (BrainService + RecallService + AttentionService) and
// the deterministic cortex pipeline in `@pkg/cortex`. Every `think()` call
// loads a fresh graph snapshot, asks the brain for its current focus / recent
// spikes / co-firing memories, then runs the six-phase cortex pipeline and
// returns a structured `Thought`.

import { Injectable, Logger } from '@nestjs/common';
import {
  regionForNode,
  think as cortexThink,
  type BrainState,
  type CortexAction,
  type CortexInput,
  type Region,
  type Thought,
} from '@pkg/cortex';
import type { NodeType } from '@pkg/shared';
import { AttentionService } from './attention.service';
import { BrainService } from './brain.service';
import { InsightsService } from './insights.service';
import { RecallService } from './recall.service';
import { ReasoningRepository } from '../reasoning/reasoning.repository';

const DEFAULT_GRAPH_LIMIT = 2_000;
const DEFAULT_MEMORY_LIMIT = 8;
const DEFAULT_MAX_DEPTH = 4;

// Hard caps protect the request thread from O(N²) blowups when a caller
// supplies a hostile or accidentally large value. They are well above any
// reasonable interactive use — graph snapshots beyond 20 k nodes are batch
// territory, not request territory.
const MAX_GRAPH_LIMIT = 20_000;
const MAX_MEMORY_LIMIT = 64;
const MAX_ASSOCIATION_DEPTH = 8;
const MAX_QUESTION_LENGTH = 2_000;

export interface CortexThinkOptions {
  question?: string;
  /** Cap on graph size loaded from Neo4j. Default 2 000 nodes. */
  graphLimit?: number;
  memoryLimit?: number;
  maxAssociationDepth?: number;
  /** When true, the proposed motor actions are executed immediately
   *  (refocus attention / inject stimulation pulse). Defaults to false. */
  enact?: boolean;
}

export interface CortexThinkResult extends Thought {
  /** Subset of `actions` that were actually executed, when `enact=true`. */
  enacted: CortexAction[];
}

@Injectable()
export class CortexService {
  private readonly log = new Logger(CortexService.name);

  constructor(
    private readonly repo: ReasoningRepository,
    private readonly brain: BrainService,
    private readonly recall: RecallService,
    private readonly attention: AttentionService,
    private readonly insights: InsightsService,
  ) {}

  async think(userId: string, opts: CortexThinkOptions = {}): Promise<CortexThinkResult> {
    const startedAt = Date.now();
    const graphLimit = clampInt(opts.graphLimit, 1, MAX_GRAPH_LIMIT, DEFAULT_GRAPH_LIMIT);
    const memoryLimit = clampInt(opts.memoryLimit, 1, MAX_MEMORY_LIMIT, DEFAULT_MEMORY_LIMIT);
    const maxDepth = clampInt(opts.maxAssociationDepth, 1, MAX_ASSOCIATION_DEPTH, DEFAULT_MAX_DEPTH);
    const question = sanitiseQuestion(opts.question);

    const graph = await this.repo.loadUserGraph(userId, graphLimit);

    const regionByNodeId: Record<string, Region> = {};
    for (const node of graph.nodes) {
      const type = node.type;
      if (!type) continue;
      try {
        regionByNodeId[node.id] = regionForNode({ type: type as NodeType });
      } catch {
        // Unknown type — leave unmapped so executive doesn't reason about it.
      }
    }

    const brainState = this.snapshotBrainState(userId);
    const input: CortexInput = {
      ...(question !== undefined ? { question } : {}),
      graph,
      regionByNodeId,
      brainState,
      memoryLimit,
      maxAssociationDepth: maxDepth,
    };

    const thought = cortexThink(input);
    const enacted = opts.enact ? await this.enactActions(userId, thought.actions) : [];

    this.log.log(
      `cortex think user=${userId} seeds=${thought.seeds.length} memories=${thought.memories.length}` +
        ` paths=${thought.associations.length} confidence=${thought.confidence.toFixed(2)}` +
        ` enacted=${enacted.length} elapsed=${Date.now() - startedAt}ms`,
    );

    return { ...thought, enacted };
  }

  /** Build a BrainState from the live runtime, swallowing missing telemetry so
   *  the cortex can still reason on a graph-only snapshot. */
  private snapshotBrainState(userId: string): BrainState {
    const state: BrainState = {};
    const focus = this.attention.current(userId);
    if (focus?.neuronIds.length) state.focusIds = [...focus.neuronIds];

    try {
      const memories = this.recall.recall(userId, { limit: 32 });
      if (memories.length > 0) {
        state.memories = memories.map((m) => ({ a: m.a, b: m.b, strength: m.strength }));
      }
    } catch (err) {
      // RecallService not started for this user — skip episodic recall.
      this.log.debug(`recall snapshot skipped user=${userId}: ${(err as Error).message}`);
    }

    try {
      // The insights snapshot is read for telemetry consistency; we don't
      // attach per-neuron spike counts (the cortex's limbic phase still
      // works without them via social + co-fire signals).
      this.insights.regions(userId);
    } catch (err) {
      this.log.debug(`insights snapshot skipped user=${userId}: ${(err as Error).message}`);
    }

    return state;
  }

  private async enactActions(
    userId: string,
    actions: CortexAction[],
  ): Promise<CortexAction[]> {
    const enacted: CortexAction[] = [];
    for (const action of actions) {
      try {
        if (action.kind === 'attend') {
          await this.attention.focus(userId, action.query, { durationMs: 30_000 });
          enacted.push(action);
        } else if (action.kind === 'stimulate') {
          this.brain.stimulate(userId, action.neuronId, action.currentMv);
          enacted.push(action);
        }
        // propose-edge and investigate are advisory — not auto-enacted.
      } catch (err) {
        this.log.warn(
          `cortex enact failed kind=${action.kind} user=${userId}: ${(err as Error).message}`,
        );
      }
    }
    return enacted;
  }
}

function clampInt(v: number | undefined, lo: number, hi: number, dflt: number): number {
  if (v === undefined) return dflt;
  if (typeof v !== 'number' || !Number.isFinite(v)) return dflt;
  const i = Math.floor(v);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function sanitiseQuestion(q: string | undefined): string | undefined {
  if (q === undefined) return undefined;
  if (typeof q !== 'string') return undefined;
  const trimmed = q.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > MAX_QUESTION_LENGTH ? trimmed.slice(0, MAX_QUESTION_LENGTH) : trimmed;
}
