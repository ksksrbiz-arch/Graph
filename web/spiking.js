// Browser-side mirror of @pkg/spiking. Same algorithm (LIF + trace-based
// STDP) so the web canvas can run a local simulation when the API isn't
// available — when it IS, this code stays dormant and Socket.IO drives the
// canvas directly.
//
// Keep this file in lock-step with packages/spiking/src/{lif,stdp,simulator}.ts
// — the algorithms are intentionally identical so the visualisation looks the
// same regardless of where the spikes come from.

export const DEFAULT_LIF = Object.freeze({
  vRest: -65,
  vReset: -70,
  vThresh: -50,
  tauMs: 20,
  refractoryMs: 4,
  inputGain: 18,
});

export const DEFAULT_STDP = Object.freeze({
  aPlus: 0.01,
  aMinus: 0.012,
  tauPlusMs: 20,
  tauMinusMs: 20,
  wMin: 0,
  wMax: 1,
});

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

export class SpikingSimulator {
  constructor(options = {}) {
    this.lif = { ...DEFAULT_LIF, ...(options.lif || {}) };
    this.stdp = { ...DEFAULT_STDP, ...(options.stdp || {}) };
    this.dtMs = options.dtMs ?? 1;
    this.bias = options.bias ?? 0;
    this.noiseRate = options.noiseRate ?? 0;
    this.plasticity = options.plasticity ?? true;
    this.rng = options.rng ?? Math.random;

    this.neurons = new Map();
    this.synapses = new Map();
    this.outgoing = new Map();
    this.incoming = new Map();
    this.pendingInput = new Map();
    this.delayedSpikes = [];
    this.tMs = 0;
    this.spikeListener = null;
    this.weightListener = null;
  }

  loadConnectome({ neurons, synapses }) {
    this.neurons.clear();
    this.synapses.clear();
    this.outgoing.clear();
    this.incoming.clear();
    this.pendingInput.clear();
    this.delayedSpikes.length = 0;

    for (const spec of neurons) {
      this.neurons.set(spec.id, {
        id: spec.id,
        v: this.lif.vRest,
        refractoryRemainingMs: 0,
        preTrace: 0,
        postTrace: 0,
        lastSpikeMs: -Infinity,
        region: spec.region,
      });
    }
    for (const s of synapses) {
      if (!this.neurons.has(s.pre) || !this.neurons.has(s.post)) continue;
      const syn = {
        id: s.id,
        pre: s.pre,
        post: s.post,
        weight: clamp(s.weight, this.stdp.wMin, this.stdp.wMax),
        delayMs: s.delayMs ?? 1,
      };
      this.synapses.set(s.id, syn);
      if (!this.outgoing.has(s.pre)) this.outgoing.set(s.pre, []);
      this.outgoing.get(s.pre).push(s.id);
      if (!this.incoming.has(s.post)) this.incoming.set(s.post, []);
      this.incoming.get(s.post).push(s.id);
    }
  }

  onSpike(fn) { this.spikeListener = fn; }
  onWeightChange(fn) { this.weightListener = fn; }

  inject(neuronId, currentMv = 12) {
    const cur = this.pendingInput.get(neuronId) ?? 0;
    this.pendingInput.set(neuronId, cur + currentMv);
  }

  step() {
    this.tMs += this.dtMs;
    this.deliverArrivedSpikes();

    for (const n of this.neurons.values()) {
      // decay traces
      if (n.preTrace !== 0) n.preTrace *= Math.exp(-this.dtMs / this.stdp.tauPlusMs);
      if (n.postTrace !== 0) n.postTrace *= Math.exp(-this.dtMs / this.stdp.tauMinusMs);

      const injected = this.pendingInput.get(n.id) ?? 0;
      const noise = this.noiseRate > 0 && this.rng() < this.noiseRate * this.dtMs ? 1 : 0;
      const input = injected + this.bias + noise;
      this.pendingInput.set(n.id, 0);

      if (n.refractoryRemainingMs > 0) {
        n.refractoryRemainingMs = Math.max(0, n.refractoryRemainingMs - this.dtMs);
        n.v = this.lif.vReset;
        continue;
      }

      const dv = (-(n.v - this.lif.vRest) + this.lif.inputGain * input) / this.lif.tauMs;
      n.v += dv * this.dtMs;

      if (n.v >= this.lif.vThresh) {
        n.v = this.lif.vReset;
        n.refractoryRemainingMs = this.lif.refractoryMs;
        n.lastSpikeMs = this.tMs;
        this.spikeListener?.({ neuronId: n.id, tMs: this.tMs, v: this.lif.vThresh, region: n.region });
        this.dispatchSpike(n);
      }
    }
  }

  dispatchSpike(pre) {
    pre.preTrace += 1;
    for (const synId of this.outgoing.get(pre.id) ?? []) {
      const syn = this.synapses.get(synId); if (!syn) continue;
      const post = this.neurons.get(syn.post); if (!post) continue;
      this.delayedSpikes.push({ arrivalMs: this.tMs + (syn.delayMs ?? 0), synapseId: syn.id });
      if (this.plasticity && post.postTrace > 0) {
        const delta = -this.stdp.aMinus * post.postTrace;
        const w = clamp(syn.weight + delta, this.stdp.wMin, this.stdp.wMax);
        if (w !== syn.weight) {
          syn.weight = w;
          this.weightListener?.({ synapseId: syn.id, pre: syn.pre, post: syn.post, weight: w, delta, tMs: this.tMs });
        }
      }
    }
    pre.postTrace += 1;
    for (const synId of this.incoming.get(pre.id) ?? []) {
      const syn = this.synapses.get(synId); if (!syn) continue;
      const upstream = this.neurons.get(syn.pre); if (!upstream) continue;
      if (this.plasticity && upstream.preTrace > 0) {
        const delta = this.stdp.aPlus * upstream.preTrace;
        const w = clamp(syn.weight + delta, this.stdp.wMin, this.stdp.wMax);
        if (w !== syn.weight) {
          syn.weight = w;
          this.weightListener?.({ synapseId: syn.id, pre: syn.pre, post: syn.post, weight: w, delta, tMs: this.tMs });
        }
      }
    }
  }

  deliverArrivedSpikes() {
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
