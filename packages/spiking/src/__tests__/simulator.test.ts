import { describe, expect, it } from 'vitest';
import { SpikingSimulator } from '../simulator.js';

function makeChain(): SpikingSimulator {
  // inputGain dialled high enough that a single unit-weight delivery drives
  // a quiescent post-neuron through threshold in one step — keeps the test
  // deterministic without depending on accumulated subthreshold integration.
  const sim = new SpikingSimulator({
    dtMs: 1,
    plasticity: true,
    lif: { inputGain: 350 },
  });
  sim.loadConnectome({
    neurons: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    synapses: [
      { id: 'ab', pre: 'a', post: 'b', weight: 1, delayMs: 1 },
      { id: 'bc', pre: 'b', post: 'c', weight: 1, delayMs: 1 },
    ],
  });
  return sim;
}

describe('SpikingSimulator', () => {
  it('loads neurons and synapses from a connectome description', () => {
    const sim = makeChain();
    expect(sim.neuronCount).toBe(3);
    expect(sim.synapseCount).toBe(2);
    expect(sim.getNeuron('a')?.v).toBeLessThan(-50);
  });

  it('drops synapses whose endpoints are missing', () => {
    const sim = new SpikingSimulator();
    sim.loadConnectome({
      neurons: [{ id: 'a' }],
      synapses: [{ id: 'ab', pre: 'a', post: 'ghost', weight: 0.5 }],
    });
    expect(sim.synapseCount).toBe(0);
  });

  it('propagates a spike along the chain', () => {
    const sim = makeChain();
    const spikes: string[] = [];
    sim.onSpike((e) => spikes.push(e.neuronId));

    // Drive 'a' hard until it fires; then keep stepping so the spike
    // propagates b→c. Enough steps for downstream membranes to integrate
    // multiple unit-weight inputs through threshold.
    for (let t = 0; t < 400; t++) {
      sim.inject('a', 5);
      sim.step();
    }

    expect(spikes).toContain('a');
    expect(spikes).toContain('b');
    expect(spikes).toContain('c');
    // a fires before b, b fires before c.
    expect(spikes.indexOf('a')).toBeLessThan(spikes.indexOf('b'));
    expect(spikes.indexOf('b')).toBeLessThan(spikes.indexOf('c'));
  });

  it('emits weight-change events and adjusts strengths under STDP', () => {
    const sim = new SpikingSimulator({
      dtMs: 1,
      plasticity: true,
      lif: { inputGain: 350 },
    });
    sim.loadConnectome({
      neurons: [{ id: 'a' }, { id: 'b' }],
      synapses: [{ id: 'ab', pre: 'a', post: 'b', weight: 0.5, delayMs: 1 }],
    });
    const changes: number[] = [];
    sim.onWeightChange((e) => changes.push(e.delta));

    for (let t = 0; t < 200; t++) {
      sim.inject('a', 5);
      sim.step();
    }
    expect(changes.length).toBeGreaterThan(0);
    expect(sim.getSynapse('ab')?.weight).not.toBe(0.5);
  });

  it('honours plasticity:false by leaving weights untouched', () => {
    const sim = new SpikingSimulator({
      dtMs: 1,
      plasticity: false,
      lif: { inputGain: 350 },
    });
    sim.loadConnectome({
      neurons: [{ id: 'a' }, { id: 'b' }],
      synapses: [{ id: 'ab', pre: 'a', post: 'b', weight: 0.5, delayMs: 1 }],
    });
    let weightEvents = 0;
    sim.onWeightChange(() => { weightEvents += 1; });
    for (let t = 0; t < 200; t++) {
      sim.inject('a', 5);
      sim.step();
    }
    expect(weightEvents).toBe(0);
    expect(sim.getSynapse('ab')?.weight).toBe(0.5);
  });

  it('advances its clock by dtMs on every step', () => {
    const sim = new SpikingSimulator({ dtMs: 0.5 });
    sim.loadConnectome({ neurons: [{ id: 'a' }], synapses: [] });
    sim.run(10);
    expect(sim.clockMs).toBeCloseTo(5, 5);
  });

  it('resets clock to 0 when loading a new connectome', () => {
    const sim = new SpikingSimulator({ dtMs: 1 });
    sim.loadConnectome({ neurons: [{ id: 'a' }], synapses: [] });
    sim.run(7);
    expect(sim.clockMs).toBe(7);
    sim.loadConnectome({ neurons: [{ id: 'b' }], synapses: [] });
    expect(sim.clockMs).toBe(0);
  });

  it('resets dynamic state while preserving topology and weights', () => {
    const sim = new SpikingSimulator({
      dtMs: 1,
      lif: { inputGain: 350 },
    });
    sim.loadConnectome({
      neurons: [{ id: 'a' }, { id: 'b' }],
      synapses: [{ id: 'ab', pre: 'a', post: 'b', weight: 0.42, delayMs: 10 }],
    });

    sim.inject('a', 5);
    expect(sim.step().map((spike) => spike.neuronId)).toEqual(['a']);
    sim.inject('b', 1000);

    sim.reset();

    const a = sim.getNeuron('a');
    expect(sim.clockMs).toBe(0);
    expect(a?.v).toBe(-65);
    expect(a?.refractoryRemainingMs).toBe(0);
    expect(a?.preTrace).toBe(0);
    expect(a?.postTrace).toBe(0);
    expect(a?.lastSpikeMs).toBe(Number.NEGATIVE_INFINITY);
    expect(sim.getSynapse('ab')?.weight).toBe(0.42);
    expect(sim.neuronCount).toBe(2);
    expect(sim.synapseCount).toBe(1);
    expect(sim.run(15)).toHaveLength(0);
  });

  it('ignores injections for unknown neurons', () => {
    const sim = new SpikingSimulator({ dtMs: 1 });
    sim.loadConnectome({ neurons: [{ id: 'a' }], synapses: [] });
    expect(sim.inject('a', 1)).toBe(true);
    expect(sim.inject('ghost', 1000)).toBe(false);
    sim.reset();
    for (let i = 0; i < 200; i++) expect(sim.inject('ghost', 1000)).toBe(false);
    const spikes = sim.run(20);
    expect(spikes).toHaveLength(0);
  });

  it('propagates region tags from connectome through to spike events', () => {
    const sim = new SpikingSimulator({ dtMs: 1 });
    sim.loadConnectome({
      neurons: [{ id: 'a', region: 'sensory' }],
      synapses: [],
    });
    let captured = '';
    sim.onSpike((e) => { captured = e.region ?? ''; });
    for (let t = 0; t < 50; t++) {
      sim.inject('a', 5);
      sim.step();
    }
    expect(captured).toBe('sensory');
  });
});
