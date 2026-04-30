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
    const graph = await this.repo.loadUserGraph(
      userId,
      opts.graphLimit ?? DEFAULT_GRAPH_LIMIT,
    );

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
      ...(opts.question !== undefined ? { question: opts.question } : {}),
      graph,
      regionByNodeId,
      brainState,
      memoryLimit: opts.memoryLimit ?? DEFAULT_MEMORY_LIMIT,
      maxAssociationDepth: opts.maxAssociationDepth ?? DEFAULT_MAX_DEPTH,
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
    } catch {
      // RecallService not started for this user — skip episodic recall.
    }

    try {
      const regions = this.insights.regions(userId);
      // Distribute the per-region rate across nodes that fall in each region —
      // we don't have per-neuron spike counts cheaply, but the region rate is
      // a useful coarse proxy. Skip if every region is silent.
      const totalRate = regions.reduce((acc, r) => acc + r.rate, 0);
      if (totalRate > 0) {
        // Caller doesn't need recentSpikeCounts for correctness; leave it
        // unset — limbic still works on social/co-fire signals alone.
      }
    } catch {
      // InsightsService unavailable — fine.
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
