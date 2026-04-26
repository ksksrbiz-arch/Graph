// Spike source manager. Tries to connect to the API's `/brain` Socket.IO
// namespace; if no API is reachable (the v1 static MVP, offline demo, etc.)
// we fall back to running the simulator locally in the browser using the
// already-loaded graph data. Either way the consumer sees the same callback
// shape: `onSpike({ neuronId, tMs, region })`.

import { SpikingSimulator } from './spiking.js';
import { regionForNode } from './cortex.js';

export function createBrainClient({ getGraph, getUserId, onSpike, onWeight }) {
  let mode = 'idle';
  let socket = null;
  let localSim = null;
  let localTimer = null;
  let stimCursor = 0;

  async function tryConnectSocket() {
    if (typeof window === 'undefined') return false;
    if (!window.io) return false;
    const userId = getUserId?.();
    if (!userId) return false;
    return new Promise((resolve) => {
      try {
        const url = `${window.location.origin}/brain`;
        const s = window.io(url, {
          transports: ['websocket'],
          query: { userId },
          timeout: 2000,
          reconnection: false,
        });
        const settle = (ok) => {
          if (settled) return;
          settled = true;
          if (ok) {
            socket = s;
            mode = 'remote';
            s.on('spike', (m) => onSpike?.({ neuronId: m.i, tMs: m.t, region: m.r }));
            s.on('weight', (m) => onWeight?.({ synapseId: m.i, pre: m.p, post: m.q, weight: m.w, delta: m.d, tMs: m.t }));
            resolve(true);
          } else {
            try { s.close(); } catch {}
            resolve(false);
          }
        };
        let settled = false;
        s.on('connect', () => settle(true));
        s.on('connect_error', () => settle(false));
        s.on('error', () => settle(false));
        setTimeout(() => settle(false), 2200);
      } catch {
        resolve(false);
      }
    });
  }

  function startLocal() {
    const graph = getGraph();
    if (!graph || graph.nodes.length === 0) return;
    localSim = new SpikingSimulator({
      dtMs: 1,
      noiseRate: 0.002,
      bias: 0.05,
      plasticity: true,
    });
    localSim.loadConnectome({
      neurons: graph.nodes.map((n) => ({ id: n.id, region: regionForNode(n) })),
      synapses: graph.edges.map((e) => ({
        id: e.id || `${srcId(e)}->${tgtId(e)}`,
        pre: srcId(e),
        post: tgtId(e),
        weight: clamp01(e.weight ?? 0.3),
        delayMs: 1,
      })),
    });
    localSim.onSpike((evt) => onSpike?.({ neuronId: evt.neuronId, tMs: evt.tMs, region: evt.region }));
    localSim.onWeightChange((evt) => onWeight?.(evt));

    const neuronIds = graph.nodes.map((n) => n.id);
    stimCursor = 0;
    localTimer = setInterval(() => {
      // Cycle a stimulus through the population so the network keeps firing.
      for (let i = 0; i < 3; i++) {
        const id = neuronIds[stimCursor % neuronIds.length];
        if (id) localSim.inject(id, 14);
        stimCursor += 1;
      }
      for (let i = 0; i < 10; i++) localSim.step();
    }, 50);
    mode = 'local';
  }

  function stopLocal() {
    if (localTimer) clearInterval(localTimer);
    localTimer = null;
    localSim = null;
  }

  return {
    async start() {
      if (mode !== 'idle') return mode;
      const ok = await tryConnectSocket();
      if (!ok) startLocal();
      return mode;
    },
    stop() {
      if (socket) { try { socket.close(); } catch {} socket = null; }
      stopLocal();
      mode = 'idle';
    },
    /** Re-load when the graph changes underneath the local simulator. */
    reloadLocal() {
      if (mode !== 'local') return;
      stopLocal();
      startLocal();
    },
    /** Inject a stimulus locally. No-op for remote mode (use REST to stim). */
    stimulate(neuronId, currentMv = 16) {
      localSim?.inject(neuronId, currentMv);
    },
    get mode() { return mode; },
  };
}

function clamp01(x) { return Math.max(0, Math.min(1, Number(x) || 0)); }
function srcId(e) { return typeof e.source === 'object' ? e.source.id : e.source; }
function tgtId(e) { return typeof e.target === 'object' ? e.target.id : e.target; }
