// Slow-wave-sleep cycle on top of the spiking layer. Periodically dampens the
// awake stimulus driver, raises spontaneous noise, and replays the most-active
// neurons from the recent past so STDP gets a consolidation pass without any
// external input. Skips the dream if the user has an active attention focus —
// deliberate thought wins over background sleep.

import { Injectable, Logger } from '@nestjs/common';
import type { SpikeEvent } from '@pkg/spiking';
import { AttentionService } from './attention.service';
import { BrainGateway } from './brain.gateway';
import { BrainService } from './brain.service';

const DEFAULT_AWAKE_MS = 5 * 60_000;
const DEFAULT_DREAM_MS = 30_000;
const REPLAY_INTERVAL_MS = 100;
const REPLAY_CURRENT = 14;
const RECENT_SPIKE_WINDOW_MS = 60_000;
const MAX_REPLAY_CANDIDATES = 32;
const SLEEP_STIM_GAIN = 0.1;
const SLEEP_NOISE_GAIN = 2.0;
const AWAKE_STIM_GAIN = 1.0;
const AWAKE_NOISE_GAIN = 1.0;

export type DreamPhase = 'awake' | 'sleeping' | 'rem';

interface DreamState {
  userId: string;
  phase: DreamPhase;
  cycleStartedAt: number;
  cycleEndsAt: number;
  recentSpikes: Array<{ neuronId: string; t: number }>;
  spikeListener: ((e: SpikeEvent) => void) | null;
  awakeMs: number;
  dreamMs: number;
  awakeTimer?: NodeJS.Timeout;
  dreamTimer?: NodeJS.Timeout;
  replayTimer?: NodeJS.Timeout;
}

export type DreamStatus = Pick<
  DreamState,
  'userId' | 'phase' | 'cycleStartedAt' | 'cycleEndsAt' | 'awakeMs' | 'dreamMs'
> & { recentSpikes: number };

@Injectable()
export class DreamService {
  private readonly logger = new Logger(DreamService.name);
  private readonly states = new Map<string, DreamState>();

  constructor(
    private readonly brain: BrainService,
    private readonly gateway: BrainGateway,
    private readonly attention: AttentionService,
  ) {}

  /** Begin the wake/sleep cycle for a user. Idempotent — returns existing
   *  status if already running. */
  start(userId: string, opts: { awakeMs?: number; dreamMs?: number } = {}): DreamStatus {
    const existing = this.states.get(userId);
    if (existing) return this.toJson(existing);

    const awakeMs = opts.awakeMs ?? DEFAULT_AWAKE_MS;
    const dreamMs = opts.dreamMs ?? DEFAULT_DREAM_MS;

    const state: DreamState = {
      userId,
      phase: 'awake',
      cycleStartedAt: Date.now(),
      cycleEndsAt: Date.now() + awakeMs,
      recentSpikes: [],
      spikeListener: null,
      awakeMs,
      dreamMs,
    };

    const listener = (e: SpikeEvent) => {
      const buf = state.recentSpikes;
      const now = Date.now();
      buf.push({ neuronId: e.neuronId, t: now });
      const cutoff = now - RECENT_SPIKE_WINDOW_MS;
      while (buf.length && buf[0]!.t < cutoff) buf.shift();
    };
    state.spikeListener = listener;
    this.brain.onSpike(userId, listener);

    state.awakeTimer = setTimeout(() => this.enterSleep(userId), awakeMs);
    this.states.set(userId, state);
    this.logger.log(`dream cycle: user=${userId} awake=${awakeMs}ms dream=${dreamMs}ms`);
    return this.toJson(state);
  }

  stop(userId: string): boolean {
    const s = this.states.get(userId);
    if (!s) return false;
    if (s.awakeTimer) clearTimeout(s.awakeTimer);
    if (s.dreamTimer) clearTimeout(s.dreamTimer);
    if (s.replayTimer) clearInterval(s.replayTimer);
    if (s.spikeListener) this.brain.offSpike(userId, s.spikeListener);
    // Restore default gains in case we were stopped mid-sleep.
    this.brain.setStimulationGain(userId, AWAKE_STIM_GAIN);
    this.brain.setNoiseGain(userId, AWAKE_NOISE_GAIN);
    this.states.delete(userId);
    this.logger.log(`dream cycle stopped: user=${userId}`);
    return true;
  }

  status(userId: string): DreamStatus | null {
    const s = this.states.get(userId);
    return s ? this.toJson(s) : null;
  }

  /** Force an immediate sleep phase. No-op if not currently awake. */
  triggerDream(userId: string, dreamMs?: number): { triggered: boolean } {
    const s = this.states.get(userId);
    if (!s || s.phase !== 'awake') return { triggered: false };
    if (s.awakeTimer) clearTimeout(s.awakeTimer);
    if (dreamMs !== undefined) s.dreamMs = dreamMs;
    this.enterSleep(userId);
    return { triggered: true };
  }

  // ── internals ───────────────────────────────────────────────
  private enterSleep(userId: string): void {
    const s = this.states.get(userId);
    if (!s) return;
    if (this.attention.current(userId)) {
      // user is actively focusing — don't interrupt; reschedule
      s.awakeTimer = setTimeout(() => this.enterSleep(userId), s.awakeMs);
      return;
    }

    s.phase = 'sleeping';
    s.cycleStartedAt = Date.now();
    s.cycleEndsAt = Date.now() + s.dreamMs;
    this.brain.setStimulationGain(userId, SLEEP_STIM_GAIN);
    this.brain.setNoiseGain(userId, SLEEP_NOISE_GAIN);

    const tally = new Map<string, number>();
    for (const sp of s.recentSpikes) {
      tally.set(sp.neuronId, (tally.get(sp.neuronId) ?? 0) + 1);
    }
    const candidates = [...tally.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_REPLAY_CANDIDATES)
      .map(([id]) => id);

    let idx = 0;
    if (candidates.length) {
      s.replayTimer = setInterval(() => {
        const id = candidates[idx % candidates.length];
        if (id) this.brain.stimulate(userId, id, REPLAY_CURRENT);
        idx++;
      }, REPLAY_INTERVAL_MS);
    }

    this.gateway.emitDream(userId, {
      phase: 'sleeping',
      endsAt: s.cycleEndsAt,
      replayCount: candidates.length,
    });
    this.logger.log(
      `dream: user=${userId} sleeping for ${s.dreamMs}ms · replay=${candidates.length}`,
    );

    s.dreamTimer = setTimeout(() => this.enterAwake(userId), s.dreamMs);
  }

  private enterAwake(userId: string): void {
    const s = this.states.get(userId);
    if (!s) return;
    if (s.replayTimer) clearInterval(s.replayTimer);
    s.replayTimer = undefined;
    s.phase = 'awake';
    s.cycleStartedAt = Date.now();
    s.cycleEndsAt = Date.now() + s.awakeMs;
    this.brain.setStimulationGain(userId, AWAKE_STIM_GAIN);
    this.brain.setNoiseGain(userId, AWAKE_NOISE_GAIN);
    this.gateway.emitDream(userId, {
      phase: 'awake',
      endsAt: s.cycleEndsAt,
      replayCount: 0,
    });
    this.logger.log(`dream: user=${userId} awake for ${s.awakeMs}ms`);
    s.awakeTimer = setTimeout(() => this.enterSleep(userId), s.awakeMs);
  }

  private toJson(s: DreamState): DreamStatus {
    return {
      userId: s.userId,
      phase: s.phase,
      cycleStartedAt: s.cycleStartedAt,
      cycleEndsAt: s.cycleEndsAt,
      awakeMs: s.awakeMs,
      dreamMs: s.dreamMs,
      recentSpikes: s.recentSpikes.length,
    };
  }
}
