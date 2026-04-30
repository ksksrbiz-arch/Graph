// Cerebral stream. Couples the live data flowing through the brain to the
// deterministic cortex pipeline so the brain *prompts itself to think*
// without the SPA ever calling /think. Four triggers fire a cortex pass:
//
//   1. Pathway formation — a synapse just crossed the formation threshold.
//      Ask "what just connected?" anchored on the new pre/post pair.
//   2. Sensory perceive — N new percepts have streamed in. Ask "what just
//      came in?" so the brain reacts to fresh data instead of only on demand.
//   3. Attention focus — the user (or another service) directed the brain at
//      something. Ask "what should I conclude about this focus?".
//   4. Dream entry — the dream cycle just put the brain into REM. Ask "what
//      should I consolidate from the past awake window?".
//
// Each trigger is rate-limited per-user so a noisy stream can't melt the
// reasoning loop, and reasoning runs are queued at most one deep — newer
// triggers replace older queued ones since the cortex always reads the
// current graph + brain state anyway.

import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, forwardRef } from '@nestjs/common';
import { AttentionService } from './attention.service';
import { BrainGateway, type DreamEvt } from './brain.gateway';
import { CortexService, type CortexThinkResult } from './cortex.service';
import { InsightsService } from './insights.service';
import { SensoryService } from './sensory.service';

/** Hook the AgentModule installs at runtime so the cerebral stream can ask
 *  the agent to enact each autonomous thought. Optional — when absent, the
 *  cerebral stream still produces thoughts, just without taking action. */
export interface CerebralAgentBridge {
  hasPermission(userId: string, scope: string): boolean;
  run(userId: string, opts: { question?: string; maxSteps?: number }): Promise<unknown>;
}

export const CEREBRAL_AGENT_BRIDGE = Symbol('CEREBRAL_AGENT_BRIDGE');

const DEFAULT_MIN_INTERVAL_MS = 4_000;
const DEFAULT_PERCEIVE_BURST = 5;
const DEFAULT_PERCEIVE_DEBOUNCE_MS = 1_500;
const MAX_REASONING_DEPTH = 3;
const RECENT_THOUGHT_RING_CAP = 10;

export type CerebralTrigger = 'formation' | 'perceive' | 'attention' | 'dream';

export interface CerebralThoughtEvent {
  userId: string;
  trigger: CerebralTrigger;
  /** Human-readable cause — e.g. "synapse abc...→def... just formed". */
  reason: string;
  /** Wall-clock when the trigger fired. */
  triggeredAt: number;
  /** The cortex pass output. */
  thought: CortexThinkResult;
}

interface UserStreamState {
  userId: string;
  lastThoughtAt: number;
  pendingTimer?: NodeJS.Timeout;
  pendingTrigger?: { trigger: CerebralTrigger; reason: string; question?: string };
  perceiveCount: number;
  perceiveTimer?: NodeJS.Timeout;
  /** Most-recent thoughts (capped) for diagnostics. */
  recentThoughts: CerebralThoughtEvent[];
}

export interface CerebralStreamOptions {
  /** Minimum gap between cortex passes per user. Default 4 s. */
  minIntervalMs?: number;
  /** Number of perceive() calls that buffer up before a "what just came in?"
   *  cortex pass fires. Default 5. */
  perceiveBurst?: number;
  /** Idle window after the last perceive() call before the buffered burst is
   *  flushed even if it hasn't reached `perceiveBurst`. Default 1.5 s. */
  perceiveDebounceMs?: number;
}

type ThoughtListener = (event: CerebralThoughtEvent) => void;

@Injectable()
export class CerebralStreamService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(CerebralStreamService.name);
  private readonly states = new Map<string, UserStreamState>();
  private readonly listeners = new Set<ThoughtListener>();
  private readonly minIntervalMs: number;
  private readonly perceiveBurst: number;
  private readonly perceiveDebounceMs: number;
  private unsubFormation?: () => void;
  private unsubPerceive?: () => void;
  private unsubAttention?: () => void;
  private unsubDream?: () => void;

  /** Optional agent bridge — installed at runtime by AgentModule via
   *  setAgentBridge(). When present, autonomous thoughts also run a
   *  permission-gated agent cycle so the brain can act on its conclusions. */
  private agentBridge: CerebralAgentBridge | null = null;

  setAgentBridge(bridge: CerebralAgentBridge | null): void {
    this.agentBridge = bridge;
  }

  constructor(
    @Inject(forwardRef(() => CortexService))
    private readonly cortex: CortexService,
    private readonly insights: InsightsService,
    private readonly sensory: SensoryService,
    private readonly attention: AttentionService,
    private readonly gateway: BrainGateway,
    options: CerebralStreamOptions = {},
  ) {
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.perceiveBurst = options.perceiveBurst ?? DEFAULT_PERCEIVE_BURST;
    this.perceiveDebounceMs = options.perceiveDebounceMs ?? DEFAULT_PERCEIVE_DEBOUNCE_MS;
  }

  onModuleInit(): void {
    this.unsubFormation = this.insights.onFormation((userId, evt) => {
      this.queue(userId, {
        trigger: 'formation',
        reason: `synapse ${shortId(evt.synapseId)} formed (${shortId(evt.pre)} → ${shortId(evt.post)})`,
        question: `Why did ${labelOrId(evt.pre)} and ${labelOrId(evt.post)} just connect?`,
      });
    });

    this.unsubPerceive = this.sensory.onPerceive((userId, node) => {
      const state = this.ensureState(userId);
      state.perceiveCount += 1;
      if (state.perceiveTimer) clearTimeout(state.perceiveTimer);
      const flush = (): void => {
        if (state.perceiveCount === 0) return;
        const count = state.perceiveCount;
        state.perceiveCount = 0;
        this.queue(userId, {
          trigger: 'perceive',
          reason: `${count} new percept${count === 1 ? '' : 's'} (latest=${shortId(node.id)})`,
          question: 'What just came in and how does it relate to what I know?',
        });
      };
      if (state.perceiveCount >= this.perceiveBurst) {
        flush();
        return;
      }
      state.perceiveTimer = setTimeout(flush, this.perceiveDebounceMs);
      if (typeof state.perceiveTimer.unref === 'function') {
        state.perceiveTimer.unref();
      }
    });

    this.unsubAttention = this.attention.onFocus((focus) => {
      this.queue(focus.userId, {
        trigger: 'attention',
        reason: `attention focused on "${focus.query}" (${focus.neuronIds.length} neurons)`,
        question: focus.query,
      });
    });

    this.unsubDream = this.gateway.onDream((userId, evt) => {
      if (evt.phase !== 'sleeping') return;
      this.queue(userId, {
        trigger: 'dream',
        reason: `dream phase started (replay=${evt.replayCount})`,
        question: 'What should I consolidate from the past awake window?',
      });
    });

    this.log.log(
      `cerebral stream live · minInterval=${this.minIntervalMs}ms · perceiveBurst=${this.perceiveBurst}`,
    );
  }

  onModuleDestroy(): void {
    this.unsubFormation?.();
    this.unsubPerceive?.();
    this.unsubAttention?.();
    this.unsubDream?.();
    for (const state of this.states.values()) {
      if (state.pendingTimer) clearTimeout(state.pendingTimer);
      if (state.perceiveTimer) clearTimeout(state.perceiveTimer);
    }
    this.states.clear();
    this.listeners.clear();
  }

  /** Subscribe to every cortex pass produced by this service. Returns an
   *  unsubscribe handle. */
  subscribe(fn: ThoughtListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The most recent N thoughts for a user, newest first. Empty until the
   *  brain has spontaneously thought at least once. */
  recent(userId: string, limit = RECENT_THOUGHT_RING_CAP): CerebralThoughtEvent[] {
    const state = this.states.get(userId);
    if (!state) return [];
    return state.recentThoughts.slice(0, Math.max(1, limit));
  }

  /** Force an immediate cortex pass for a user, bypassing the rate limiter.
   *  Useful for tests and for the SPA's "think now" button. */
  async fire(
    userId: string,
    trigger: CerebralTrigger,
    reason: string,
    question?: string,
  ): Promise<CerebralThoughtEvent | null> {
    return this.run(userId, { trigger, reason, ...(question ? { question } : {}) });
  }

  // ── internals ────────────────────────────────────────────────────────

  private queue(
    userId: string,
    pending: { trigger: CerebralTrigger; reason: string; question?: string },
  ): void {
    const state = this.ensureState(userId);
    state.pendingTrigger = pending;
    if (state.pendingTimer) return; // already scheduled

    const elapsed = Date.now() - state.lastThoughtAt;
    const wait = Math.max(0, this.minIntervalMs - elapsed);
    state.pendingTimer = setTimeout(() => {
      state.pendingTimer = undefined;
      const next = state.pendingTrigger;
      state.pendingTrigger = undefined;
      if (!next) return;
      void this.run(userId, next).catch((err) =>
        this.log.warn(`cerebral run failed user=${userId}: ${(err as Error).message}`),
      );
    }, wait);
    if (typeof state.pendingTimer.unref === 'function') {
      state.pendingTimer.unref();
    }
  }

  private async run(
    userId: string,
    pending: { trigger: CerebralTrigger; reason: string; question?: string },
  ): Promise<CerebralThoughtEvent | null> {
    try {
      const thought = await this.cortex.think(userId, {
        ...(pending.question !== undefined ? { question: pending.question } : {}),
        maxAssociationDepth: MAX_REASONING_DEPTH,
        // Don't auto-enact when the cortex fires reflexively — the SafetySupervisor
        // and the user's intent should remain in charge of motor actions.
        enact: false,
      });
      const state = this.ensureState(userId);
      state.lastThoughtAt = Date.now();
      const event: CerebralThoughtEvent = {
        userId,
        trigger: pending.trigger,
        reason: pending.reason,
        triggeredAt: state.lastThoughtAt,
        thought,
      };
      state.recentThoughts.unshift(event);
      if (state.recentThoughts.length > RECENT_THOUGHT_RING_CAP) {
        state.recentThoughts.length = RECENT_THOUGHT_RING_CAP;
      }
      this.gateway.emitThought(userId, event);
      for (const fn of this.listeners) {
        try {
          fn(event);
        } catch (err) {
          this.log.warn(`thought listener crashed: ${(err as Error).message}`);
        }
      }
      this.log.log(
        `cerebral think user=${userId} trigger=${pending.trigger} confidence=${thought.confidence.toFixed(2)} reason="${pending.reason}"`,
      );

      // If the agent bridge is installed AND the user has granted the agent
      // motor enactment, hand the thought back so it can take action. The
      // bridge handles its own permission checks per-tool — this top-level
      // gate just keeps autonomous agent cycles off by default.
      if (this.agentBridge?.hasPermission(userId, 'agent:enact-motor')) {
        try {
          await this.agentBridge.run(userId, {
            ...(pending.question ? { question: pending.question } : {}),
            maxSteps: 4,
          });
        } catch (err) {
          this.log.warn(
            `cerebral agent run failed user=${userId}: ${(err as Error).message}`,
          );
        }
      }

      return event;
    } catch (err) {
      this.log.warn(`cerebral think failed user=${userId}: ${(err as Error).message}`);
      return null;
    }
  }

  private ensureState(userId: string): UserStreamState {
    const existing = this.states.get(userId);
    if (existing) return existing;
    const fresh: UserStreamState = {
      userId,
      lastThoughtAt: 0,
      perceiveCount: 0,
      recentThoughts: [],
    };
    this.states.set(userId, fresh);
    return fresh;
  }
}

function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}

function labelOrId(id: string): string {
  return shortId(id);
}

// Re-export for convenience so the gateway type union stays in sync.
export type { DreamEvt };
