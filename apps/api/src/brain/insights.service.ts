// Live observability into the brain's plasticity. Subscribes to BrainService
// spike + weight streams and maintains per-user, bounded aggregates so the
// SPA can answer questions like:
//
//   - which region is busiest right now?
//   - which synapses have grown the most in the last few minutes?
//   - has any synapse just crossed the "this is a real pathway" threshold?
//   - how big is the connectome today vs an hour ago?
//
// Everything is in-memory and bounded — no DB writes. Phase 1+ may persist a
// timeseries to Postgres for historical charts, but the live insight panel
// just needs the recent past.

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { REGION_STYLES, type Region } from '@pkg/cortex';
import type { WeightChangeEvent } from '@pkg/spiking';
import { BrainService } from './brain.service';
import type {
  BrainInsightsSummary,
  ConnectomeSnapshot,
  PathwayFormationEvent,
  PathwaySummary,
  RegionActivity,
} from './insights.types';

const SPIKE_WINDOW_MS = 30_000;
const MAX_SPIKES_TRACKED = 4_000;
const FORMATION_THRESHOLD = 0.55; // weight that counts as "a real pathway"
const MAX_FORMATIONS_TRACKED = 64;
const GROWTH_SAMPLE_INTERVAL_MS = 60_000;
const MAX_GROWTH_SAMPLES = 60; // 60 minutes of 1-min samples

interface PathwayState {
  synapseId: string;
  pre: string;
  post: string;
  /** Weight when we first saw this synapse this session. */
  baselineWeight: number;
  weight: number;
  /** Most recent observed delta sign — for "decaying" detection. */
  lastChangeAt?: number;
  /** True once this synapse crossed FORMATION_THRESHOLD upward; prevents
   *  re-emitting a formation event each time it wobbles around the line. */
  formed: boolean;
}

interface UserInsights {
  userId: string;
  /** Spike timestamps + region tag, capped at MAX_SPIKES_TRACKED. */
  spikes: Array<{ tMs: number; observedAt: number; region: Region | null }>;
  pathways: Map<string, PathwayState>;
  formations: PathwayFormationEvent[];
  growth: ConnectomeSnapshot[];
  growthTimer: NodeJS.Timeout;
  unsubSpike: () => void;
  unsubWeight: () => void;
  formationListeners: Set<(e: PathwayFormationEvent) => void>;
}

type FormationListener = (userId: string, e: PathwayFormationEvent) => void;

@Injectable()
export class InsightsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(InsightsService.name);
  private readonly users = new Map<string, UserInsights>();
  private readonly globalFormationListeners = new Set<FormationListener>();
  private brainSpikeUnsub?: () => void;
  private brainWeightUnsub?: () => void;

  constructor(private readonly brain: BrainService) {}

  onModuleInit(): void {
    // BrainService publishes (userId, event) on every spike + weight change
    // for every running brain. Lazily allocate per-user aggregates the first
    // time we see a user.
    this.brainSpikeUnsub = this.brain.subscribeSpikes((userId, e) => {
      this.ensureUser(userId).spikes.push({
        tMs: e.tMs,
        observedAt: Date.now(),
        region: (e.region as Region | undefined) ?? null,
      });
      this.trim(userId);
    });
    this.brainWeightUnsub = this.brain.subscribeWeights((userId, e) =>
      this.recordWeight(userId, e),
    );
  }

  onModuleDestroy(): void {
    this.brainSpikeUnsub?.();
    this.brainWeightUnsub?.();
    for (const u of this.users.values()) {
      clearInterval(u.growthTimer);
      u.unsubSpike();
      u.unsubWeight();
    }
    this.users.clear();
  }

  /** Subscribe to pathway-formation events for any user. SyncGateway and the
   *  /brain WebSocket use this to broadcast "a new pathway just formed!". */
  onFormation(fn: FormationListener): () => void {
    this.globalFormationListeners.add(fn);
    return () => this.globalFormationListeners.delete(fn);
  }

  summary(userId: string, opts: { topN?: number } = {}): BrainInsightsSummary {
    const topN = Math.max(1, Math.min(50, opts.topN ?? 10));
    const u = this.users.get(userId);
    const running = this.brain.isRunning(userId);

    const regions = this.regionActivity(u);
    const pathways = u ? [...u.pathways.values()] : [];

    const strongest = this.toSummaries(
      [...pathways].sort((a, b) => b.weight - a.weight).slice(0, topN),
    );
    const growing = this.toSummaries(
      [...pathways]
        .map((p) => ({ p, delta: p.weight - p.baselineWeight }))
        .filter((x) => x.delta > 0)
        .sort((a, b) => b.delta - a.delta)
        .slice(0, topN)
        .map((x) => x.p),
    );
    const decaying = this.toSummaries(
      [...pathways]
        .map((p) => ({ p, delta: p.weight - p.baselineWeight }))
        .filter((x) => x.delta < 0)
        .sort((a, b) => a.delta - b.delta)
        .slice(0, topN)
        .map((x) => x.p),
    );

    return {
      running,
      windowMs: SPIKE_WINDOW_MS,
      regions,
      strongestPathways: strongest,
      growingPathways: growing,
      decayingPathways: decaying,
      recentFormations: u ? u.formations.slice(0, topN) : [],
      growth: u ? [...u.growth] : [],
    };
  }

  /** Hand back just the region histogram — cheaper for the WS push tick. */
  regions(userId: string): RegionActivity[] {
    return this.regionActivity(this.users.get(userId));
  }

  // ── internals ──

  private ensureUser(userId: string): UserInsights {
    const existing = this.users.get(userId);
    if (existing) return existing;

    const fresh: UserInsights = {
      userId,
      spikes: [],
      pathways: new Map(),
      formations: [],
      growth: [],
      growthTimer: setInterval(
        () => this.sampleGrowth(userId),
        GROWTH_SAMPLE_INTERVAL_MS,
      ),
      // Per-user direct subscriptions are a no-op for now since we already
      // listen globally — but stub them so onModuleDestroy can clean up
      // future per-user listeners without special-casing.
      unsubSpike: () => {},
      unsubWeight: () => {},
      formationListeners: new Set(),
    };
    if (typeof fresh.growthTimer.unref === 'function') {
      fresh.growthTimer.unref();
    }
    this.users.set(userId, fresh);
    // Seed the first growth sample immediately so the SPA has a non-empty
    // chart on first load.
    setImmediate(() => this.sampleGrowth(userId));
    return fresh;
  }

  private recordWeight(userId: string, e: WeightChangeEvent): void {
    const u = this.ensureUser(userId);
    const now = Date.now();
    const existing = u.pathways.get(e.synapseId);
    const baseline = existing?.baselineWeight ?? e.weight - e.delta;
    const next: PathwayState = {
      synapseId: e.synapseId,
      pre: e.pre,
      post: e.post,
      baselineWeight: baseline,
      weight: e.weight,
      lastChangeAt: now,
      formed: existing?.formed ?? false,
    };
    u.pathways.set(e.synapseId, next);

    if (!next.formed && next.weight >= FORMATION_THRESHOLD) {
      next.formed = true;
      const event: PathwayFormationEvent = {
        synapseId: e.synapseId,
        pre: e.pre,
        post: e.post,
        weight: e.weight,
        formedAt: new Date(now).toISOString(),
      };
      u.formations.unshift(event);
      if (u.formations.length > MAX_FORMATIONS_TRACKED) {
        u.formations.length = MAX_FORMATIONS_TRACKED;
      }
      for (const fn of this.globalFormationListeners) {
        try {
          fn(userId, event);
        } catch (err) {
          this.log.warn(`formation listener crashed: ${(err as Error).message}`);
        }
      }
    }
  }

  private trim(userId: string): void {
    const u = this.users.get(userId);
    if (!u) return;
    const cutoff = Date.now() - SPIKE_WINDOW_MS;
    while (u.spikes.length > 0 && u.spikes[0]!.observedAt < cutoff) {
      u.spikes.shift();
    }
    if (u.spikes.length > MAX_SPIKES_TRACKED) {
      u.spikes.splice(0, u.spikes.length - MAX_SPIKES_TRACKED);
    }
  }

  private regionActivity(u: UserInsights | undefined): RegionActivity[] {
    const counts = new Map<Region, number>();
    if (u) {
      const cutoff = Date.now() - SPIKE_WINDOW_MS;
      for (const s of u.spikes) {
        if (s.observedAt < cutoff || !s.region) continue;
        counts.set(s.region, (counts.get(s.region) ?? 0) + 1);
      }
    }
    const windowSec = SPIKE_WINDOW_MS / 1000;
    return (Object.keys(REGION_STYLES) as Region[]).map((region) => {
      const count = counts.get(region) ?? 0;
      const style = REGION_STYLES[region];
      return {
        region,
        count,
        rate: count / windowSec,
        color: style.color,
        label: style.label,
      };
    });
  }

  private toSummaries(states: PathwayState[]): PathwaySummary[] {
    return states.map((p) => ({
      synapseId: p.synapseId,
      pre: p.pre,
      post: p.post,
      weight: p.weight,
      delta: p.weight - p.baselineWeight,
      ...(p.lastChangeAt
        ? { lastChangeAt: new Date(p.lastChangeAt).toISOString() }
        : {}),
    }));
  }

  private sampleGrowth(userId: string): void {
    const u = this.users.get(userId);
    if (!u) return;
    const pathways = [...u.pathways.values()];
    const synapses = pathways.length;
    const neurons = new Set<string>();
    for (const p of pathways) {
      neurons.add(p.pre);
      neurons.add(p.post);
    }
    const meanWeight =
      synapses === 0
        ? 0
        : pathways.reduce((acc, p) => acc + p.weight, 0) / synapses;

    u.growth.push({
      at: new Date().toISOString(),
      neurons: neurons.size,
      synapses,
      meanWeight,
    });
    if (u.growth.length > MAX_GROWTH_SAMPLES) u.growth.shift();
  }
}
