// Orchestrates spiking simulators — one per user-owned connectome. Each
// simulator runs on a setInterval timer; spike + weight events are published
// through `subscribeSpikes` / `subscribeWeights`, which the WebSocket
// gateway fans out to connected clients.

import { forwardRef, Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import {
  SpikingSimulator,
  type SimulatorOptions,
  type SpikeEvent,
  type WeightChangeEvent,
} from '@pkg/spiking';
import { ConnectomeLoader } from './connectome.loader';
import { RecallService } from './recall.service';

interface RunningBrain {
  userId: string;
  sim: SpikingSimulator;
  timer: NodeJS.Timeout;
  checkpointTimer: NodeJS.Timeout;
  /** Synapse id → weight at the last checkpoint. Lets `checkpoint()` skip
   *  synapses whose strength hasn't drifted enough to be worth a write. */
  lastWeights: Map<string, number>;
  /** Index of the next neuron to receive a stimulus pulse. */
  stimCursor: number;
  /** Sorted neuron ids — for cycling stimuli through the population. */
  neuronIds: string[];
  /** Per-user spike listeners — DreamService / RecallService subscribe here. */
  spikeListeners: Set<PerUserSpikeListener>;
  /** Awake-stimulus multiplier; DreamService dampens this during sleep. */
  stimGain: number;
  /** Noise multiplier relative to the configured baseline. */
  noiseGain: number;
  /** Baseline noise rate captured at start(); setNoiseGain scales this. */
  baseNoiseRate: number;
}

const STEP_INTERVAL_MS = 50;
const STEPS_PER_TICK = 10;
const STIMULUS_NEURONS_PER_TICK = 3;
const STIMULUS_CURRENT_MV = 14;
const CHECKPOINT_INTERVAL_MS = 5 * 60 * 1000; // 5 min
const CHECKPOINT_MIN_DELTA = 0.02;            // skip if no synapse moved more than 2%
const DEFAULT_NOISE_RATE = 0.002;

type SpikeListener = (userId: string, e: SpikeEvent) => void;
type WeightListener = (userId: string, e: WeightChangeEvent) => void;
type PerUserSpikeListener = (e: SpikeEvent) => void;

@Injectable()
export class BrainService implements OnModuleDestroy {
  private readonly log = new Logger(BrainService.name);
  private readonly running = new Map<string, RunningBrain>();
  private readonly spikeListeners = new Set<SpikeListener>();
  private readonly weightListeners = new Set<WeightListener>();

  constructor(
    private readonly loader: ConnectomeLoader,
    @Inject(forwardRef(() => RecallService))
    private readonly recall: RecallService,
  ) {}

  /** Start (or restart) the simulator for a user. Idempotent. */
  async start(userId: string, options: SimulatorOptions = {}): Promise<{
    neurons: number;
    synapses: number;
  }> {
    this.stop(userId);

    const connectome = await this.loader.loadForUser(userId);
    const baseNoiseRate = options.noiseRate ?? DEFAULT_NOISE_RATE;
    const sim = new SpikingSimulator({
      dtMs: 1,
      noiseRate: baseNoiseRate,
      bias: 0.05,
      plasticity: true,
      ...options,
    });
    sim.loadConnectome(connectome);

    const spikeListeners = new Set<PerUserSpikeListener>();
    sim.onSpike((e) => {
      for (const fn of this.spikeListeners) fn(userId, e);
      for (const fn of spikeListeners) fn(e);
    });
    sim.onWeightChange((e) => {
      for (const fn of this.weightListeners) fn(userId, e);
    });

    const neuronIds = connectome.neurons.map((n) => n.id);

    // Snapshot weights now so the first checkpoint only writes synapses that
    // have actually drifted from their loaded baseline.
    const lastWeights = new Map<string, number>();
    for (const w of sim.weights()) lastWeights.set(w.id, w.weight);

    const checkpointTimer = setInterval(() => {
      void this.checkpoint(userId).catch((e) =>
        this.log.warn(`checkpoint failed: ${(e as Error).message}`),
      );
    }, CHECKPOINT_INTERVAL_MS);

    const brain: RunningBrain = {
      userId,
      sim,
      stimCursor: 0,
      neuronIds,
      lastWeights,
      checkpointTimer,
      spikeListeners,
      stimGain: 1.0,
      noiseGain: 1.0,
      baseNoiseRate,
      timer: setInterval(() => this.tick(brain), STEP_INTERVAL_MS),
    };
    this.running.set(userId, brain);
    this.recall.start(userId);

    this.log.log(
      `brain started user=${userId} neurons=${neuronIds.length} synapses=${connectome.synapses.length}`,
    );
    return { neurons: neuronIds.length, synapses: connectome.synapses.length };
  }

  stop(userId: string): boolean {
    const b = this.running.get(userId);
    if (!b) return false;
    clearInterval(b.timer);
    clearInterval(b.checkpointTimer);
    this.recall.stop(userId);
    // Final checkpoint on stop — fire-and-forget. checkpoint() reads the brain
    // synchronously before its first await, so deleting from `running` below
    // does not race with the persistence write.
    void this.checkpoint(userId).catch((e) =>
      this.log.warn(`final checkpoint failed: ${(e as Error).message}`),
    );
    this.running.delete(userId);
    this.log.log(`brain stopped user=${userId}`);
    return true;
  }

  isRunning(userId: string): boolean {
    return this.running.has(userId);
  }

  /** External stimulus injection (e.g. when a new node is ingested). */
  stimulate(userId: string, neuronId: string, currentMv = 16): void {
    this.running.get(userId)?.sim.inject(neuronId, currentMv);
  }

  subscribeSpikes(fn: SpikeListener): () => void {
    this.spikeListeners.add(fn);
    return () => this.spikeListeners.delete(fn);
  }

  subscribeWeights(fn: WeightListener): () => void {
    this.weightListeners.add(fn);
    return () => this.weightListeners.delete(fn);
  }

  /** Subscribe to spike events from a single user's brain. Used by DreamService
   *  / RecallService so they don't have to pay the global-fan-out cost just to
   *  filter to one userId. No-op if the brain isn't currently running. */
  onSpike(userId: string, fn: PerUserSpikeListener): void {
    this.running.get(userId)?.spikeListeners.add(fn);
  }

  /** Detach a per-user listener. Without `fn`, clears all listeners for the
   *  user. */
  offSpike(userId: string, fn?: PerUserSpikeListener): void {
    const b = this.running.get(userId);
    if (!b) return;
    if (fn) b.spikeListeners.delete(fn);
    else b.spikeListeners.clear();
  }

  /** Multiplier on the awake stimulus driver. DreamService drops this to ~0.1
   *  during sleep so the cycling pulse barely fires. Clamped to >= 0. */
  setStimulationGain(userId: string, gain: number): void {
    const b = this.running.get(userId);
    if (!b) return;
    b.stimGain = Math.max(0, gain);
  }

  /** Multiplier on the spontaneous noise rate (relative to the rate at start).
   *  DreamService raises this during sleep so the network has something to
   *  replay. Propagated to the simulator immediately. */
  setNoiseGain(userId: string, gain: number): void {
    const b = this.running.get(userId);
    if (!b) return;
    b.noiseGain = Math.max(0, gain);
    b.sim.setNoiseRate(b.baseNoiseRate * b.noiseGain);
  }

  /**
   * Persist any synapse whose weight has drifted by at least
   * `CHECKPOINT_MIN_DELTA` from its last persisted value. Returns counts so
   * callers (timer, controller, shutdown hook) can log progress.
   */
  async checkpoint(userId: string): Promise<{ persisted: number; skipped: number }> {
    const b = this.running.get(userId);
    if (!b) return { persisted: 0, skipped: 0 };
    const current = b.sim.weights();
    const dirty: Array<{ id: string; weight: number }> = [];
    for (const w of current) {
      const prev = b.lastWeights.get(w.id);
      if (prev === undefined || Math.abs(w.weight - prev) >= CHECKPOINT_MIN_DELTA) {
        dirty.push({ id: w.id, weight: w.weight });
        b.lastWeights.set(w.id, w.weight);
      }
    }
    if (dirty.length > 0) {
      await this.loader.persistWeights(dirty);
      this.log.log(
        `checkpoint user=${userId}: persisted ${dirty.length}/${current.length} synapses`,
      );
    }
    return { persisted: dirty.length, skipped: current.length - dirty.length };
  }

  async onModuleDestroy(): Promise<void> {
    for (const userId of [...this.running.keys()]) {
      try {
        await this.checkpoint(userId);
      } catch {
        // swallow — shutdown should never throw
      }
      this.stop(userId);
    }
  }

  private tick(brain: RunningBrain): void {
    if (brain.neuronIds.length > 0 && brain.stimGain > 0) {
      // Cycle a stimulus pulse through the population so the network breathes
      // even without external traffic. New ingest events override this via
      // `stimulate(...)`. DreamService dampens stimGain to ~0.1 during sleep.
      const current = STIMULUS_CURRENT_MV * brain.stimGain;
      for (let i = 0; i < STIMULUS_NEURONS_PER_TICK; i++) {
        const id = brain.neuronIds[brain.stimCursor % brain.neuronIds.length];
        if (id) brain.sim.inject(id, current);
        brain.stimCursor += 1;
      }
    }
    for (let i = 0; i < STEPS_PER_TICK; i++) brain.sim.step();
  }
}
