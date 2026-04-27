import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { SpikingSimulator, type SpikeEvent, type WeightChangeEvent } from '@pkg/spiking';
import { ConnectomeLoader } from './connectome-loader.js';
import { BrainGateway } from './brain.gateway.js';

interface RunningBrain {
  userId: string;
  sim: SpikingSimulator;
  /** Total wall-clock spikes so far (for diagnostics). */
  spikes: number;
  /** Map from neuron id → region. Used to tint client-side renders. */
  regions: Map<string, string>;
  /** wall-clock timer that drives `sim.tick()`. */
  timer: NodeJS.Timeout;
  /** Background stimulus pulse — keeps the network breathing. */
  stimTimer: NodeJS.Timeout;
}

const TICK_INTERVAL_MS = 50;
const SIM_STEPS_PER_TICK = 10;
const SIM_DT_MS = 1; // 10 × 1ms steps per 50ms wall = 200× faster than realtime
const STIM_INTERVAL_MS = 800;

/**
 * One simulator per user. Phase 0 services exactly one user (the demo user)
 * but the map indirection means scaling to many users is just provisioning
 * work, not code.
 */
@Injectable()
export class BrainService implements OnModuleDestroy {
  private readonly logger = new Logger(BrainService.name);
  private readonly brains = new Map<string, RunningBrain>();

  constructor(
    private readonly loader: ConnectomeLoader,
    private readonly gateway: BrainGateway,
  ) {}

  async start(userId: string): Promise<{ neurons: number; synapses: number }> {
    if (this.brains.has(userId)) {
      const b = this.brains.get(userId)!;
      return { neurons: b.sim.neuronCount, synapses: b.sim.synapseCount };
    }

    this.logger.log(`booting brain for user=${userId}`);
    const { neurons, synapses } = await this.loader.loadFor(userId);
    const sim = new SpikingSimulator({ params: { noise: 1.5 } });
    sim.addNeurons(neurons);
    sim.addSynapses(synapses);

    const regions = new Map<string, string>();
    for (const n of neurons) regions.set(n.id, n.region);

    // Wire simulator events → Socket.IO
    sim.on('spike', (e: SpikeEvent) => {
      this.gateway.emitSpike(userId, {
        neuronId: e.neuronId,
        region: regions.get(e.neuronId) ?? 'association',
        outgoing: e.outgoing,
        t: e.t,
      });
    });
    sim.on('weight-change', (e: WeightChangeEvent) => {
      this.gateway.emitWeightChange(userId, e);
    });
    sim.on('tick', (e) => this.gateway.emitTick(userId, e));

    const timer = setInterval(() => {
      for (let i = 0; i < SIM_STEPS_PER_TICK; i++) sim.tick(SIM_DT_MS);
    }, TICK_INTERVAL_MS);

    // Background stimulus — every ~800ms cycle a pulse through the population
    let stimIdx = 0;
    const stimTimer = setInterval(() => {
      if (sim.neuronCount === 0) return;
      // Round-robin a small set of "high-importance" neurons via degree.
      const hub = sim.hubNeuron();
      if (hub) sim.injectCurrent(hub, 14);
      // Plus a random weak nudge somewhere — keeps things from being purely periodic.
      const allIds = neurons.map((n) => n.id);
      const random = allIds[stimIdx % allIds.length];
      if (random) sim.injectCurrent(random, 6);
      stimIdx++;
    }, STIM_INTERVAL_MS);

    this.brains.set(userId, { userId, sim, spikes: 0, regions, timer, stimTimer });
    this.logger.log(
      `brain started: ${sim.neuronCount} neurons · ${sim.synapseCount} synapses`,
    );
    return { neurons: sim.neuronCount, synapses: sim.synapseCount };
  }

  stop(userId: string): boolean {
    const b = this.brains.get(userId);
    if (!b) return false;
    clearInterval(b.timer);
    clearInterval(b.stimTimer);
    this.brains.delete(userId);
    this.logger.log(`brain stopped for user=${userId}`);
    return true;
  }

  stimulate(userId: string, neuronId: string, current = 30): boolean {
    const b = this.brains.get(userId);
    if (!b) return false;
    b.sim.injectCurrent(neuronId, current);
    return true;
  }

  status(userId: string): { running: boolean; neurons: number; synapses: number; tMs: number } {
    const b = this.brains.get(userId);
    if (!b) return { running: false, neurons: 0, synapses: 0, tMs: 0 };
    return {
      running: true,
      neurons: b.sim.neuronCount,
      synapses: b.sim.synapseCount,
      tMs: b.sim.simTimeMs,
    };
  }

  onModuleDestroy(): void {
    for (const userId of [...this.brains.keys()]) this.stop(userId);
  }
}
