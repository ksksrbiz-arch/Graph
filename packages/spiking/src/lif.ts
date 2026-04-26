// Leaky integrate-and-fire dynamics. Forward Euler, one neuron per call.
//
//   τ · dV/dt = -(V - V_rest) + I(t)
//
// On V ≥ V_thresh the neuron emits a spike, V is reset to V_reset, and a
// refractory timer starts during which V stays clamped at V_reset.

import type { LifParams, Neuron } from './types.js';

export function makeNeuron(id: string, vRest: number): Neuron {
  return {
    id,
    v: vRest,
    refractoryRemainingMs: 0,
    preTrace: 0,
    postTrace: 0,
    lastSpikeMs: Number.NEGATIVE_INFINITY,
  };
}

/**
 * Step a single neuron forward by `dtMs`. Returns true iff the neuron spiked
 * during this step. The caller is responsible for propagating spikes to
 * downstream synapses and updating STDP traces.
 */
export function stepNeuron(
  n: Neuron,
  inputCurrent: number,
  params: LifParams,
  dtMs: number,
  tNowMs: number,
): boolean {
  if (n.refractoryRemainingMs > 0) {
    n.refractoryRemainingMs = Math.max(0, n.refractoryRemainingMs - dtMs);
    n.v = params.vReset;
    return false;
  }

  // Forward Euler integration of the LIF ODE.
  const dv = (-(n.v - params.vRest) + params.inputGain * inputCurrent) / params.tauMs;
  n.v += dv * dtMs;

  if (n.v >= params.vThresh) {
    n.v = params.vReset;
    n.refractoryRemainingMs = params.refractoryMs;
    n.lastSpikeMs = tNowMs;
    return true;
  }
  return false;
}
