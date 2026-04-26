// Pair-based STDP using exponential traces (Morrison/Pfister 2008 style).
// Each neuron carries two traces:
//   • preTrace  — bumps to 1 on a pre-synaptic spike, decays with τ₊
//   • postTrace — bumps to 1 on a post-synaptic spike, decays with τ₋
//
// On a pre→post spike pair: weight increases by  +A₊ · postTrace_post (acausal
// reading: when the post fires, every recent pre gets potentiated). On a
// post→pre pair (pre fires while post recently fired): weight decreases by
// −A₋ · preTrace_pre. The trace formulation is mathematically equivalent to
// the original double-loop sum but is O(1) per spike.

import type { Neuron, StdpParams } from './types.js';

export function decayTraces(n: Neuron, params: StdpParams, dtMs: number): void {
  if (n.preTrace !== 0) n.preTrace *= Math.exp(-dtMs / params.tauPlusMs);
  if (n.postTrace !== 0) n.postTrace *= Math.exp(-dtMs / params.tauMinusMs);
}

export function onPreSpike(n: Neuron): void {
  n.preTrace += 1;
}

export function onPostSpike(n: Neuron): void {
  n.postTrace += 1;
}

export function clampWeight(w: number, params: StdpParams): number {
  if (w < params.wMin) return params.wMin;
  if (w > params.wMax) return params.wMax;
  return w;
}

/** Pre-before-post update: when the post neuron fires, every synapse from a
 *  pre that fired recently gets potentiated proportionally to that pre's
 *  current preTrace. Returns the new weight. */
export function potentiate(
  weight: number,
  prePostNeuronPreTrace: number,
  params: StdpParams,
): { weight: number; delta: number } {
  const delta = params.aPlus * prePostNeuronPreTrace;
  return { weight: clampWeight(weight + delta, params), delta };
}

/** Post-before-pre update: when the pre neuron fires, every synapse to a
 *  post that fired recently gets depressed proportionally to that post's
 *  current postTrace. Returns the new weight. */
export function depress(
  weight: number,
  postNeuronPostTrace: number,
  params: StdpParams,
): { weight: number; delta: number } {
  const delta = -params.aMinus * postNeuronPostTrace;
  return { weight: clampWeight(weight + delta, params), delta };
}
