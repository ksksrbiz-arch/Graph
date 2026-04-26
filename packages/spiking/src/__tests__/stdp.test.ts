import { describe, expect, it } from 'vitest';
import { makeNeuron } from '../lif.js';
import {
  clampWeight,
  decayTraces,
  depress,
  onPostSpike,
  onPreSpike,
  potentiate,
} from '../stdp.js';
import { DEFAULT_LIF, DEFAULT_STDP } from '../types.js';

describe('STDP', () => {
  it('clamps weights into [wMin, wMax]', () => {
    expect(clampWeight(-1, DEFAULT_STDP)).toBe(DEFAULT_STDP.wMin);
    expect(clampWeight(2, DEFAULT_STDP)).toBe(DEFAULT_STDP.wMax);
    expect(clampWeight(0.5, DEFAULT_STDP)).toBe(0.5);
  });

  it('decays traces exponentially toward zero', () => {
    const n = makeNeuron('x', DEFAULT_LIF.vRest);
    onPreSpike(n);
    onPostSpike(n);
    const initial = n.preTrace;
    decayTraces(n, DEFAULT_STDP, DEFAULT_STDP.tauPlusMs);
    // After one τ the trace should be ~1/e of its starting value.
    expect(n.preTrace).toBeCloseTo(initial * Math.exp(-1), 5);
    expect(n.postTrace).toBeLessThan(1);
  });

  it('potentiates when pre fired before post (positive delta)', () => {
    const post = makeNeuron('post', DEFAULT_LIF.vRest);
    onPreSpike(post); // pre-trace at the synapse pre-side; we model by trace=1
    const { weight, delta } = potentiate(0.4, post.preTrace, DEFAULT_STDP);
    expect(delta).toBeGreaterThan(0);
    expect(weight).toBeGreaterThan(0.4);
  });

  it('depresses when post fired before pre (negative delta)', () => {
    const post = makeNeuron('post', DEFAULT_LIF.vRest);
    onPostSpike(post);
    const { weight, delta } = depress(0.4, post.postTrace, DEFAULT_STDP);
    expect(delta).toBeLessThan(0);
    expect(weight).toBeLessThan(0.4);
  });

  it('respects the bidirectional asymmetry — Δ+ ≠ |Δ−| with default params', () => {
    const trace = 1;
    const { delta: up } = potentiate(0.5, trace, DEFAULT_STDP);
    const { delta: dn } = depress(0.5, trace, DEFAULT_STDP);
    expect(Math.abs(dn)).toBeGreaterThan(up);
  });
});
