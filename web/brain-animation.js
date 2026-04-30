// Brain animation orchestrator. Tracks per-node visual state (glow / heat /
// scale / phase) and a flock of particles travelling between nodes, then
// notifies subscribers each time something changes. The overlay canvas
// (web/views/brain-overlay.js) is the primary subscriber; the ingest panel
// also reads activityLog for its "Log" tab.
//
// State is plain JS — no framework. Subscribers receive snapshots they can
// freely treat as immutable. Every animation is RAF-driven so it idles when
// the tab is backgrounded.
//
// Exposed actions:
//   spawnNode(id, parentId?)           — new node arrived from ingest
//   traceQuery(startId, links)         — BFS ripple, e.g. on search focus
//   inferenceArc(fromId, toId, reason) — long-distance reasoning hop
//
// Each action also pushes a one-line entry to activityLog (capped at 100).

const PARTICLE_BASE_DURATION_MS = 800;
const SPAWN_DURATION_MS = 600;
const FLASH_FADE_MS = 350;
const TRACE_DEPTH_LIMIT = 5;
const TRACE_STEP_DELAY_MS = 80;
const HEAT_INCREMENT = 0.15;
const ACTIVITY_LOG_MAX = 100;

export function createBrainAnimation() {
  /** @type {Map<string, { nodeId: string, heat: number, glowIntensity: number, scale: number, phase: 'spawning'|'idle'|'active'|'tracing' }>} */
  const nodeStates = new Map();
  /** @type {Array<{ id: string, fromNodeId: string, toNodeId: string, progress: number, color: string, startedAt: number, durationMs: number, stagger: number }>} */
  let particles = [];
  /** @type {string[]} */
  let activityLog = [];
  const subs = new Set();

  function snapshot() {
    return { nodeStates, particles, activityLog };
  }
  function publish() {
    const snap = snapshot();
    for (const fn of subs) {
      try { fn(snap); } catch (err) { console.warn('[brain-animation] subscriber threw', err); }
    }
  }

  function subscribe(fn) {
    subs.add(fn);
    fn(snapshot());
    return () => subs.delete(fn);
  }

  function log(msg) {
    activityLog = [`${new Date().toLocaleTimeString()} — ${msg}`, ...activityLog].slice(0, ACTIVITY_LOG_MAX);
  }

  function setNodeState(nodeId, patch) {
    const prev = nodeStates.get(nodeId);
    const base = prev || { nodeId, heat: 0, glowIntensity: 0, scale: 1, phase: 'idle' };
    nodeStates.set(nodeId, { ...base, ...patch, nodeId });
  }

  // ── public actions ──────────────────────────────────────

  function spawnNode(nodeId, parentNodeId) {
    setNodeState(nodeId, { heat: 0.2, glowIntensity: 1, scale: 0, phase: 'spawning' });

    const start = performance.now();
    const tick = (now) => {
      const t = Math.min((now - start) / SPAWN_DURATION_MS, 1);
      const eased = elasticOut(t);
      const state = nodeStates.get(nodeId);
      if (!state) return;
      const glow = t < 0.9 ? 1 : 1 - (t - 0.9) / 0.1;
      if (t >= 1) {
        setNodeState(nodeId, { scale: 1, glowIntensity: 0, phase: 'idle' });
      } else {
        setNodeState(nodeId, { scale: eased, glowIntensity: glow });
      }
      publish();
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    if (parentNodeId) {
      spawnParticleStream(parentNodeId, nodeId, '#00ffaa', 800, 12);
    }

    log(`Node spawned: ${nodeId}`);
    publish();
  }

  function traceQuery(startNodeId, links) {
    if (!startNodeId) return;
    const adjacency = buildAdjacency(links || []);
    const visited = new Set();
    const queue = [{ id: startNodeId, depth: 0 }];

    const step = () => {
      if (queue.length === 0) return;
      const { id, depth } = queue.shift();
      if (visited.has(id) || depth > TRACE_DEPTH_LIMIT) {
        if (queue.length) setTimeout(step, 30);
        return;
      }
      visited.add(id);
      flashNode(id, '#00d4ff', depth * 60);

      for (const neighbor of adjacency.get(id) || []) {
        if (!visited.has(neighbor)) {
          queue.push({ id: neighbor, depth: depth + 1 });
          spawnParticleStream(id, neighbor, '#00d4ff', 400, 4);
        }
      }
      bumpHeat(id);
      setTimeout(step, TRACE_STEP_DELAY_MS);
    };
    step();
    log(`Query trace from: ${startNodeId}`);
  }

  function inferenceArc(fromId, toId, reason = '') {
    spawnParticleStream(fromId, toId, '#ff9500', 1200, 8);
    flashNode(fromId, '#ff9500', 0);
    flashNode(toId, '#ff9500', 400);
    log(`Inference: ${fromId} → ${toId}${reason ? ` (${reason})` : ''}`);
  }

  // ── internals ───────────────────────────────────────────

  function flashNode(nodeId, _color, delayMs) {
    setTimeout(() => {
      setNodeState(nodeId, { glowIntensity: 1, phase: 'active' });
      publish();
      setTimeout(() => {
        const cur = nodeStates.get(nodeId);
        if (cur) setNodeState(nodeId, { glowIntensity: 0, phase: 'idle' });
        publish();
      }, FLASH_FADE_MS);
    }, delayMs);
  }

  function bumpHeat(nodeId) {
    const cur = nodeStates.get(nodeId);
    const next = Math.min(1, (cur?.heat ?? 0) + HEAT_INCREMENT);
    setNodeState(nodeId, { heat: next });
  }

  function spawnParticleStream(fromId, toId, color, durationMs, count) {
    if (!fromId || !toId || fromId === toId) return;
    const startedAt = performance.now();
    const fresh = Array.from({ length: count }, (_, i) => ({
      id: `${fromId}->${toId}@${startedAt.toFixed(0)}#${i}`,
      fromNodeId: fromId,
      toNodeId: toId,
      progress: -(i / count) * 0.4, // stagger so the stream looks like a flow
      color,
      startedAt,
      durationMs: durationMs || PARTICLE_BASE_DURATION_MS,
      stagger: i / count,
    }));
    particles = [...particles, ...fresh];
    publish();

    const tick = (now) => {
      const elapsed = now - startedAt;
      let alive = false;
      particles = particles.map((p) => {
        if (p.startedAt !== startedAt) return p;
        const t = elapsed / p.durationMs - p.stagger * 0.4;
        if (t > 1.05) return p; // will be filtered below
        if (t > -0.05) alive = true;
        return { ...p, progress: t };
      }).filter((p) => p.startedAt !== startedAt || p.progress <= 1.05);
      publish();
      if (alive || elapsed < durationMs * 1.5) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function elasticOut(t) {
    if (t === 0 || t === 1) return t;
    return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * (2 * Math.PI) / 3) + 1;
  }

  function buildAdjacency(links) {
    const adj = new Map();
    for (const l of links) {
      const s = typeof l.source === 'object' ? l.source.id : l.source;
      const t = typeof l.target === 'object' ? l.target.id : l.target;
      if (!s || !t) continue;
      if (!adj.has(s)) adj.set(s, []);
      if (!adj.has(t)) adj.set(t, []);
      adj.get(s).push(t);
      adj.get(t).push(s);
    }
    return adj;
  }

  return {
    subscribe,
    spawnNode,
    traceQuery,
    inferenceArc,
    snapshot,
  };
}
