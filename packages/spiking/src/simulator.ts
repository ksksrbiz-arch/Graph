// Network simulator. Owns neurons + synapses, integrates everything one
// time-step at a time, and emits spike / weight-change events through the
// listener callbacks. Designed so a single `step()` call is cheap enough to
// run inside a setInterval / setTimeout loop in either Node or the browser.

import { makeNeuron, stepNeuron } from './lif.js';
import {
  clampWeight,
  decayTraces,
  depress,
  onPostSpike,
  onPreSpike,
  potentiate,
} from './stdp.js';
import {
  DEFAULT_LIF,
  DEFAULT_STDP,
  type LifParams,
  type Neuron,
  type SimulatorOptions,
  type SpikeEvent,
  type StdpParams,
  type Synapse,
  type WeightChangeEvent,
} from './types.js';

export interface ConnectomeInput {
  neurons: Array<{ id: string; region?: string }>;
  synapses: Array<{
    id: string;
    pre: string;
    post: string;
    weight: number;
    delayMs?: number;
  }>;
}

interface DelayedSpike {
  arrivalMs: number;
  synapseId: string;
}

export class SpikingSimulator {
  private readonly lif: LifParams;
  private readonly stdp: StdpParams;
  private readonly dtMs: number;
  private readonly bias: number;
  private readonly noiseRate: number;
  private readonly plasticity: boolean;
  private readonly rng: () => number;

  private readonly neurons = new Map<string, Neuron>();
  private readonly synapses = new Map<string, Synapse>();
  /** preNeuronId -> outgoing synapse ids */
  private readonly outgoing = new Map<string, string[]>();
  /** postNeuronId -> incoming synapse ids */
  private readonly incoming = new Map<string, string[]>();

  /** Per-neuron pending input current for the next step (mV). */
  private readonly pendingInput = new Map<string, number>();
  /** Spikes still in flight along an axon. */
  private readonly delayedSpikes: DelayedSpike[] = [];

  private tMs = 0;
  private spikeListener: ((e: SpikeEvent) => void) | null = null;
  private weightListener: ((e: WeightChangeEvent) => void) | null = null;

  constructor(options: SimulatorOptions = {}) {
    this.lif = { ...DEFAULT_LIF, ...options.lif };
    this.stdp = { ...DEFAULT_STDP, ...options.stdp };
    this.dtMs = options.dtMs ?? 1;
    this.bias = options.bias ?? 0;
    this.noiseRate = options.noiseRate ?? 0;
    this.plasticity = options.plasticity ?? true;
    this.rng = options.rng ?? Math.random;
  }

  loadConnectome(input: ConnectomeInput): void {
    this.neurons.clear();
    this.synapses.clear();
    this.outgoing.clear();
    this.incoming.clear();
    this.pendingInput.clear();
    this.delayedSpikes.length = 0;

    for (const spec of input.neurons) {
      const n = makeNeuron(spec.id, this.lif.vRest);
      if (spec.region !== undefined) n.region = spec.region;
      this.neurons.set(spec.id, n);
    }

    for (const s of input.synapses) {
      if (!this.neurons.has(s.pre) || !this.neurons.has(s.post)) continue;
      const synapse: Synapse = {
        id: s.id,
        pre: s.pre,
        post: s.post,
        weight: clampWeight(s.weight, this.stdp),
        ...(s.delayMs !== undefined ? { delayMs: s.delayMs } : {}),
      };
      this.synapses.set(s.id, synapse);
      const out = this.outgoing.get(s.pre) ?? [];
      out.push(s.id);
      this.outgoing.set(s.pre, out);
      const inc = this.incoming.get(s.post) ?? [];
      inc.push(s.id);
      this.incoming.set(s.post, inc);
    }
  }

  onSpike(fn: (e: SpikeEvent) => void): void {
    this.spikeListener = fn;
  }

  onWeightChange(fn: (e: WeightChangeEvent) => void): void {
    this.weightListener = fn;
  }

  /** Force-inject a spike at the next step. Useful for stimuli / tests. */
  inject(neuronId: string, currentMv = 12): void {
    const cur = this.pendingInput.get(neuronId) ?? 0;
    this.pendingInput.set(neuronId, cur + currentMv);
  }

  getNeuron(id: string): Neuron | undefined {
    return this.neurons.get(id);
  }

  getSynapse(id: string): Synapse | undefined {
    return this.synapses.get(id);
  }

  /** Snapshot of every synapse's current strength. Used by the persistence
   *  layer to checkpoint learned weights back to the knowledge graph. */
  weights(): Array<{ id: string; source: string; target: string; weight: number }> {
    const out: Array<{ id: string; source: string; target: string; weight: number }> = [];
    for (const s of this.synapses.values()) {
      out.push({ id: s.id, source: s.pre, target: s.post, weight: s.weight });
    }
    return out;
  }

  get clockMs(): number {
    return this.tMs;
  }

  get neuronCount(): number {
    return this.neurons.size;
  }

  get synapseCount(): number {
    return this.synapses.size;
  }

  /** Advance the simulation by one `dtMs` step. Returns the spikes emitted
   *  during this step (the same events are also dispatched to the listener). */
  step(): SpikeEvent[] {
    this.tMs += this.dtMs;
    this.deliverArrivedSpikes();

    const spikes: SpikeEvent[] = [];

    for (const n of this.neurons.values()) {
      decayTraces(n, this.stdp, this.dtMs);

      const injected = this.pendingInput.get(n.id) ?? 0;
      const noise =
        this.noiseRate > 0 && this.rng() < this.noiseRate * this.dtMs ? 1 : 0;
      const input = injected + this.bias + noise;
      this.pendingInput.set(n.id, 0);

      const fired = stepNeuron(n, input, this.lif, this.dtMs, this.tMs);
      if (!fired) continue;

      const spike: SpikeEvent = {
        neuronId: n.id,
        tMs: this.tMs,
        v: this.lif.vThresh,
      };
      if (n.region !== undefined) spike.region = n.region;
      spikes.push(spike);
      this.spikeListener?.(spike);

      this.dispatchSpike(n);
    }

    return spikes;
  }

  /** Run `nSteps` and return all spikes (also delivered via listener). */
  run(nSteps: number): SpikeEvent[] {
    const all: SpikeEvent[] = [];
    for (let i = 0; i < nSteps; i++) {
      const s = this.step();
      if (s.length > 0) all.push(...s);
    }
    return all;
  }

  // ── internals ──

  private dispatchSpike(pre: Neuron): void {
    onPreSpike(pre);

    // Post-before-pre depression: this pre just fired, so penalise every
    // incoming synapse (looking back through the synapse: its post is THIS
    // neuron, its pre is some other neuron's recent activity… wait, actually
    // we want the OUTGOING side here for depression-on-pre-firing). Convention:
    //
    //   pre fires now → for every outgoing synapse pre→X, look at X.postTrace.
    //   If X spiked recently, that's a post-before-pre pattern → depress.
    for (const synId of this.outgoing.get(pre.id) ?? []) {
      const syn = this.synapses.get(synId);
      if (!syn) continue;
      const post = this.neurons.get(syn.post);
      if (!post) continue;

      // Schedule the spike's arrival at the post neuron.
      const arrivalMs = this.tMs + (syn.delayMs ?? 0);
      this.delayedSpikes.push({ arrivalMs, synapseId: syn.id });

      if (this.plasticity && post.postTrace > 0) {
        const { weight, delta } = depress(syn.weight, post.postTrace, this.stdp);
        if (delta !== 0) {
          syn.weight = weight;
          this.weightListener?.({
            synapseId: syn.id,
            pre: syn.pre,
            post: syn.post,
            weight,
            delta,
            tMs: this.tMs,
          });
        }
      }
    }

    // Pre-before-post potentiation: pre fires now → for every INCOMING synapse
    // (X→pre), if X has a recent preTrace, that's a pre-before-post pattern.
    onPostSpike(pre);
    for (const synId of this.incoming.get(pre.id) ?? []) {
      const syn = this.synapses.get(synId);
      if (!syn) continue;
      const upstream = this.neurons.get(syn.pre);
      if (!upstream) continue;
      if (this.plasticity && upstream.preTrace > 0) {
        const { weight, delta } = potentiate(
          syn.weight,
          upstream.preTrace,
          this.stdp,
        );
        if (delta !== 0) {
          syn.weight = weight;
          this.weightListener?.({
            synapseId: syn.id,
            pre: syn.pre,
            post: syn.post,
            weight,
            delta,
            tMs: this.tMs,
          });
        }
      }
    }
  }

  private deliverArrivedSpikes(): void {
    if (this.delayedSpikes.length === 0) return;
    let kept = 0;
    for (const ev of this.delayedSpikes) {
      if (ev.arrivalMs <= this.tMs) {
        const syn = this.synapses.get(ev.synapseId);
        if (syn) {
          const cur = this.pendingInput.get(syn.post) ?? 0;
          this.pendingInput.set(syn.post, cur + syn.weight);
        }
      } else {
        this.delayedSpikes[kept++] = ev;
      }
    }
    this.delayedSpikes.length = kept;
  }
}
