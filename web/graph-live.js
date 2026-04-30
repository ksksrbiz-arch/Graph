// Polls the public /graph/delta endpoint and emits each non-empty delta to
// subscribers. The poll cadence is configurable; subscribers see the new
// nodes + edges and a server-supplied `ts` they can echo back next round.
//
// Stays paused until startPolling() is called and stops cleanly on
// stopPolling() — the graph view starts/stops it on view enter/leave so
// background tabs don't churn.

import { loadGraphDelta } from './data.js';

const DEFAULT_INTERVAL_MS = 3_000;

export function createGraphLive({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  let timer = null;
  let inFlight = false;
  let lastTs = new Date(0).toISOString();
  const subs = new Set();

  function subscribe(fn) {
    subs.add(fn);
    return () => subs.delete(fn);
  }

  async function tick() {
    if (inFlight) return; // don't queue if the previous request is still pending
    inFlight = true;
    try {
      const delta = await loadGraphDelta(lastTs);
      if (!delta) return;
      const ts = delta.metadata?.ts;
      if (ts) lastTs = ts;
      if (delta.nodes.length === 0 && delta.edges.length === 0) return;
      for (const fn of subs) {
        try { fn(delta); } catch (err) { console.warn('[graph-live] subscriber threw', err); }
      }
    } finally {
      inFlight = false;
    }
  }

  function startPolling() {
    if (timer) return;
    // Skip the very first delta — when polling first turns on we treat the
    // current graph as the baseline; otherwise we'd replay every existing
    // node as a "new" spawn animation on page load.
    lastTs = new Date().toISOString();
    timer = setInterval(tick, intervalMs);
  }

  function stopPolling() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return { subscribe, startPolling, stopPolling };
}
