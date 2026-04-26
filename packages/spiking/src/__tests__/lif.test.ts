import { describe, expect, it } from 'vitest';
import { makeNeuron, stepNeuron } from '../lif.js';
import { DEFAULT_LIF } from '../types.js';

describe('LIF neuron', () => {
  it('relaxes toward V_rest when no input is supplied', () => {
    const n = makeNeuron('a', DEFAULT_LIF.vRest);
    n.v = -55; // pushed up
    for (let i = 0; i < 200; i++) stepNeuron(n, 0, DEFAULT_LIF, 1, i);
    expect(n.v).toBeCloseTo(DEFAULT_LIF.vRest, 1);
  });

  it('fires once threshold is crossed and enters refractoriness', () => {
    const n = makeNeuron('a', DEFAULT_LIF.vRest);
    let firstSpikeStep = -1;
    for (let i = 0; i < 100; i++) {
      const fired = stepNeuron(n, 1, DEFAULT_LIF, 1, i);
      if (fired) { firstSpikeStep = i; break; }
    }
    expect(firstSpikeStep).toBeGreaterThan(0);
    expect(n.v).toBe(DEFAULT_LIF.vReset);
    expect(n.refractoryRemainingMs).toBe(DEFAULT_LIF.refractoryMs);
  });

  it('stays clamped to V_reset throughout refractoriness even with strong input', () => {
    const n = makeNeuron('a', DEFAULT_LIF.vRest);
    while (!stepNeuron(n, 1, DEFAULT_LIF, 1, 0)) { /* drive to first spike */ }
    const refractorySteps = DEFAULT_LIF.refractoryMs;
    for (let i = 0; i < refractorySteps; i++) {
      const fired = stepNeuron(n, 5, DEFAULT_LIF, 1, i + 100);
      expect(fired).toBe(false);
      expect(n.v).toBe(DEFAULT_LIF.vReset);
    }
  });

  it('produces a regular spike train under constant supra-threshold input', () => {
    const n = makeNeuron('a', DEFAULT_LIF.vRest);
    const spikeTimes: number[] = [];
    for (let t = 0; t < 500; t++) {
      if (stepNeuron(n, 1, DEFAULT_LIF, 1, t)) spikeTimes.push(t);
    }
    expect(spikeTimes.length).toBeGreaterThan(5);
    // ISIs should converge to a constant: difference of consecutive deltas → 0.
    const isis = spikeTimes.slice(1).map((t, i) => t - spikeTimes[i]!);
    const last = isis.slice(-3);
    const range = Math.max(...last) - Math.min(...last);
    expect(range).toBeLessThanOrEqual(1);
  });
});
