// Public types for the spiking simulator. The connectome maps 1:1 onto the
// knowledge graph: every node becomes a Neuron, every edge becomes a Synapse,
// and the edge weight (0–1 in the KG schema) seeds the initial synaptic
// strength.

export interface Neuron {
  /** Stable identifier — by convention, the KGNode id. */
  id: string;
  /** Membrane potential (mV). */
  v: number;
  /** Refractory countdown in ms; > 0 ⇒ neuron is silent. */
  refractoryRemainingMs: number;
  /** Pre-synaptic STDP trace; decays toward 0 between pre-spikes. */
  preTrace: number;
  /** Post-synaptic STDP trace; decays toward 0 between post-spikes. */
  postTrace: number;
  /** Last spike time (ms, simulator clock) or -Infinity if never. */
  lastSpikeMs: number;
  /** Optional region/cluster tag — populated by `@pkg/cortex`. */
  region?: string;
}

export interface Synapse {
  /** Stable identifier — by convention, the KGEdge id. */
  id: string;
  /** Pre-synaptic neuron id. */
  pre: string;
  /** Post-synaptic neuron id. */
  post: string;
  /** Synaptic strength. Updated by STDP, clamped to [wMin, wMax]. */
  weight: number;
  /** Optional axonal delay (ms). Spikes arrive after this delay. */
  delayMs?: number;
}

export interface SpikeEvent {
  neuronId: string;
  /** Simulator clock at spike time (ms). */
  tMs: number;
  /** Membrane potential immediately before reset. */
  v: number;
  /** Optional region tag (mirrored from the neuron). */
  region?: string;
}

export interface WeightChangeEvent {
  synapseId: string;
  pre: string;
  post: string;
  /** Weight after the update. */
  weight: number;
  /** Signed delta applied. */
  delta: number;
  /** Simulator clock at the moment of change (ms). */
  tMs: number;
}

export interface LifParams {
  /** Resting potential (mV). */
  vRest: number;
  /** Reset potential after a spike (mV). */
  vReset: number;
  /** Spike threshold (mV). */
  vThresh: number;
  /** Membrane time constant (ms). */
  tauMs: number;
  /** Absolute refractory period (ms). */
  refractoryMs: number;
  /** Synaptic input scaling — converts arriving weight to mV input. */
  inputGain: number;
}

export const DEFAULT_LIF: LifParams = {
  vRest: -65,
  vReset: -70,
  vThresh: -50,
  tauMs: 20,
  refractoryMs: 4,
  inputGain: 18,
};

export interface StdpParams {
  /** Potentiation amplitude (pre-before-post). */
  aPlus: number;
  /** Depression amplitude (post-before-pre). */
  aMinus: number;
  /** Pre-synaptic trace decay constant (ms). */
  tauPlusMs: number;
  /** Post-synaptic trace decay constant (ms). */
  tauMinusMs: number;
  /** Lower clamp for synaptic weight. */
  wMin: number;
  /** Upper clamp for synaptic weight. */
  wMax: number;
}

export const DEFAULT_STDP: StdpParams = {
  aPlus: 0.01,
  aMinus: 0.012,
  tauPlusMs: 20,
  tauMinusMs: 20,
  wMin: 0,
  wMax: 1,
};

export interface SimulatorOptions {
  lif?: Partial<LifParams>;
  stdp?: Partial<StdpParams>;
  /** Integration step in ms. */
  dtMs?: number;
  /** Background drive applied to every neuron each step (mV). */
  bias?: number;
  /** Probability per step of an injected Poisson spike per neuron [0..1]. */
  noiseRate?: number;
  /** Whether STDP should adjust weights at runtime. Defaults to true. */
  plasticity?: boolean;
  /** Deterministic RNG. Defaults to Math.random. */
  rng?: () => number;
}
