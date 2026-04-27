// Brain construction & thinking renderer.
//
// Paints onto the same force-graph canvas via `onRenderFramePost`, alongside
// `spike-render.js`. Provides three classes of visual events that — together
// with the existing spike pulses — make the graph feel like a brain being
// procedurally built and actively thinking:
//
//   • Node birth          — particles converge from a random ring offscreen,
//                           collapse into a bright burst, and leave a soft
//                           halo pulsing for ~1.5 s. Inspired by the
//                           multicolored neurons in the reference photos.
//   • Synapse growth      — a glowing tendril grows from `src` to `tgt`,
//                           shedding sparks at the leading edge. The tendril
//                           dims into the regular edge style once it lands.
//   • Thinking wave       — a BFS ripple from a root id (selected/recent
//                           node, or graph centroid) lights up edges in
//                           waves while the cortex reasons.
//
// Unlike `spike-render.js`, this renderer also tracks an internal "previous
// graph" snapshot so it can detect newly-arrived nodes and edges between
// `setData` calls and play birth/growth animations for them — without any
// changes to the data plane upstream.

import { regionForNode, styleForRegion } from './cortex.js';
import { srcId, tgtId } from './util.js';

const NODE_BIRTH_DURATION_MS    = 1600;
const EDGE_GROWTH_DURATION_MS   = 1100;
const THINK_WAVE_DURATION_MS    = 2400;
const PARTICLES_PER_BIRTH       = 10;
const SPARKS_PER_GROWTH         = 8;

const MAX_BIRTHS = 240;
const MAX_GROWTHS = 480;
const MAX_WAVES = 12;

// Mobile caps so a 100-node ingest doesn't chew through a phone's battery.
// Coarse pointer is the most reliable signal (covers tablets too).
const MOBILE_MAX_BIRTHS  = 60;
const MOBILE_MAX_GROWTHS = 120;
const MOBILE_MAX_WAVES   = 4;
const MOBILE_PARTICLES_PER_BIRTH = 6;
const MOBILE_SPARKS_PER_GROWTH = 4;

function isMobile() {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia?.('(pointer: coarse)').matches) return true;
  return Math.min(window.innerWidth || 9999, window.innerHeight || 9999) <= 820;
}

export function createBrainConstruction(fg, state) {
  const births  = [];   // { nodeId, color, bornMs, particles[] }
  const growths = [];   // { edge, color, bornMs, sparks[] }
  const waves   = [];   // { rootId, bornMs, color, ripples[] }

  const seenNodes = new Set();
  const seenEdges = new Set();
  let active = false;
  let attached = false;
  let firstSync = true; // skip animations on the very first graph load

  // Re-evaluated on each spawn so a window resize that crosses the mobile
  // breakpoint takes effect on subsequent animations.
  function caps() {
    return isMobile()
      ? {
          maxBirths:  MOBILE_MAX_BIRTHS,
          maxGrowths: MOBILE_MAX_GROWTHS,
          maxWaves:   MOBILE_MAX_WAVES,
          particles:  MOBILE_PARTICLES_PER_BIRTH,
          sparks:     MOBILE_SPARKS_PER_GROWTH,
        }
      : {
          maxBirths:  MAX_BIRTHS,
          maxGrowths: MAX_GROWTHS,
          maxWaves:   MAX_WAVES,
          particles:  PARTICLES_PER_BIRTH,
          sparks:     SPARKS_PER_GROWTH,
        };
  }

  function tintFor(neuronId) {
    const node = state.byId.get(neuronId);
    if (!node) return '#7c9cff';
    const region = node.region || regionForNode(node);
    return styleForRegion(region).color;
  }

  function edgeKey(e) { return `${srcId(e)}::${tgtId(e)}`; }

  // ── Public hooks ────────────────────────────────────────────────────

  /** Diff the current graph against the last sync and queue birth/growth
   *  animations for everything that just appeared. Skipped on the first
   *  sync so a fresh page load doesn't fire 1000 animations at once. */
  function syncFromGraph() {
    const nodes = state.graph?.nodes || [];
    const edges = state.graph?.edges || [];
    const seenNow = new Set();
    const seenEdgesNow = new Set();
    const newNodes = [];
    const newEdges = [];

    for (const n of nodes) {
      seenNow.add(n.id);
      if (!firstSync && !seenNodes.has(n.id)) newNodes.push(n);
    }
    for (const e of edges) {
      const k = edgeKey(e);
      seenEdgesNow.add(k);
      if (!firstSync && !seenEdges.has(k)) newEdges.push(e);
    }

    if (firstSync) {
      firstSync = false;
    } else {
      // Stagger so 50 new nodes don't all flash on the same tick.
      newNodes.forEach((n, i) => spawnBirth(n.id, i * 35));
      newEdges.forEach((e, i) => spawnGrowth(e, 200 + i * 25));
    }

    // Rebuild the seen sets so removed nodes don't linger.
    seenNodes.clear();
    seenEdges.clear();
    for (const id of seenNow) seenNodes.add(id);
    for (const k of seenEdgesNow) seenEdges.add(k);
  }

  /** Manually trigger a birth animation for a node id (used for stimulate/
   *  insight bursts and from the cortex ReAct loop). */
  function spawnBirth(neuronId, delayMs = 0) {
    const node = state.byId.get(neuronId);
    if (!node) return;
    const c = caps();
    if (births.length >= c.maxBirths) births.shift();
    const color = tintFor(neuronId);
    const particles = [];
    for (let i = 0; i < c.particles; i++) {
      const angle = (i / c.particles) * Math.PI * 2 + Math.random() * 0.4;
      const dist = 60 + Math.random() * 80;
      particles.push({ angle, dist });
    }
    births.push({
      nodeId: neuronId,
      color,
      bornMs: now() + delayMs,
      particles,
    });
  }

  /** Manually trigger a growth animation for a known edge object. */
  function spawnGrowth(edge, delayMs = 0) {
    const c = caps();
    if (growths.length >= c.maxGrowths) growths.shift();
    const color = tintFor(srcId(edge));
    const sparks = [];
    for (let i = 0; i < c.sparks; i++) {
      sparks.push({
        offsetT: Math.random() * 0.18,
        wobble: (Math.random() - 0.5) * 14,
      });
    }
    growths.push({
      edge,
      color,
      bornMs: now() + delayMs,
      sparks,
    });
  }

  /** Trigger a thinking ripple from a root node, propagating BFS-style
   *  through the graph for the duration of the wave. Multiple waves can
   *  overlap. `color` defaults to a warm orange to evoke the second
   *  reference photo. */
  function spawnThinkWave(rootId, color = '#ff8a3d') {
    if (!rootId || !state.byId.has(rootId)) {
      // Pick a random hub-ish node so something visible always happens.
      const nodes = state.graph?.nodes || [];
      if (nodes.length === 0) return;
      const top = [...nodes].sort((a, b) => (b.__degree || 0) - (a.__degree || 0)).slice(0, 12);
      rootId = top[Math.floor(Math.random() * top.length)].id;
    }
    const c = caps();
    if (waves.length >= c.maxWaves) waves.shift();
    const ripples = bfsRipples(rootId, isMobile() ? 3 : 4, 280);
    waves.push({ rootId, bornMs: now(), color, ripples });
  }

  function bfsRipples(rootId, maxDepth, msPerLayer) {
    const visited = new Set([rootId]);
    let frontier = [rootId];
    const layers = []; // layers[d] = [{edge, depth}]
    for (let d = 0; d < maxDepth; d++) {
      const layer = [];
      const next = [];
      for (const id of frontier) {
        const out = state.outgoing?.get(id) || [];
        for (const edge of out) {
          const other = srcId(edge) === id ? tgtId(edge) : srcId(edge);
          if (visited.has(other)) continue;
          visited.add(other);
          layer.push({ edge, depth: d, startMs: d * msPerLayer });
          next.push(other);
        }
      }
      if (layer.length === 0) break;
      layers.push(layer);
      frontier = next;
    }
    // Flatten with start times so the painter only iterates one array.
    const flat = [];
    for (const layer of layers) for (const r of layer) flat.push(r);
    return flat;
  }

  // ── Drawing ─────────────────────────────────────────────────────────

  function paint(ctx, scale) {
    const t = now();

    // Paint thinking waves first so they sit behind births/growths.
    for (let i = waves.length - 1; i >= 0; i--) {
      const w = waves[i];
      const age = t - w.bornMs;
      if (age >= THINK_WAVE_DURATION_MS) { waves.splice(i, 1); continue; }
      paintWave(ctx, scale, w, age);
    }

    for (let i = growths.length - 1; i >= 0; i--) {
      const g = growths[i];
      const age = t - g.bornMs;
      if (age < 0) continue;
      if (age >= EDGE_GROWTH_DURATION_MS) { growths.splice(i, 1); continue; }
      paintGrowth(ctx, scale, g, age);
    }

    for (let i = births.length - 1; i >= 0; i--) {
      const b = births[i];
      const age = t - b.bornMs;
      if (age < 0) continue;
      if (age >= NODE_BIRTH_DURATION_MS) { births.splice(i, 1); continue; }
      paintBirth(ctx, scale, b, age);
    }
  }

  function paintBirth(ctx, scale, b, age) {
    const node = state.byId.get(b.nodeId);
    if (!node || node.x == null || node.y == null) return;
    const u = age / NODE_BIRTH_DURATION_MS;

    // Phase 1 (0..0.45): particles converge from the ring → centre.
    // Phase 2 (0.40..0.65): bright burst flash.
    // Phase 3 (0.55..1.0): soft halo pulse fading out.

    // Particles converging.
    if (u < 0.5) {
      const k = 1 - Math.min(1, u / 0.45);          // 1 → 0 over the converge
      const eased = k * k;                          // ease-in to feel like gravity
      ctx.save();
      for (const p of b.particles) {
        const r = p.dist * eased;
        const px = node.x + Math.cos(p.angle) * r;
        const py = node.y + Math.sin(p.angle) * r;
        ctx.beginPath();
        ctx.arc(px, py, 1.6, 0, Math.PI * 2);
        ctx.fillStyle = withAlpha(b.color, 0.85 * (0.4 + 0.6 * (1 - k)));
        ctx.fill();
        // A short trailing line toward the centre sells the convergence.
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(node.x + Math.cos(p.angle) * (r * 0.6),
                   node.y + Math.sin(p.angle) * (r * 0.6));
        ctx.strokeStyle = withAlpha(b.color, 0.35 * (1 - k));
        ctx.lineWidth = 0.8 / scale;
        ctx.stroke();
      }
      ctx.restore();
    }

    // Burst flash.
    if (u >= 0.4 && u <= 0.7) {
      const k = (u - 0.4) / 0.3;
      const flashAlpha = 1 - k;
      const flashR = 6 + k * 16;
      ctx.beginPath();
      ctx.arc(node.x, node.y, flashR, 0, Math.PI * 2);
      ctx.fillStyle = withAlpha('#ffffff', 0.65 * flashAlpha);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(node.x, node.y, flashR * 1.6, 0, Math.PI * 2);
      ctx.fillStyle = withAlpha(b.color, 0.45 * flashAlpha);
      ctx.fill();
    }

    // Halo pulse.
    if (u >= 0.5) {
      const k = (u - 0.5) / 0.5;
      const haloR = 8 + k * 14;
      const a = (1 - k) * 0.55;
      ctx.beginPath();
      ctx.arc(node.x, node.y, haloR, 0, Math.PI * 2);
      ctx.lineWidth = 1.4 / scale;
      ctx.strokeStyle = withAlpha(b.color, a);
      ctx.stroke();
    }
  }

  function paintGrowth(ctx, scale, g, age) {
    const sNode = state.byId.get(srcId(g.edge));
    const tNode = state.byId.get(tgtId(g.edge));
    if (!sNode || !tNode || sNode.x == null || tNode.x == null) return;
    const u = Math.min(1, age / EDGE_GROWTH_DURATION_MS);
    // Ease-out cubic so the tendril decelerates as it lands.
    const eased = 1 - Math.pow(1 - u, 3);

    const x0 = sNode.x, y0 = sNode.y;
    const x1 = sNode.x + (tNode.x - sNode.x) * eased;
    const y1 = sNode.y + (tNode.y - sNode.y) * eased;

    // Tendril shaft — a thicker glow line plus a bright core.
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineWidth = 2.5 / scale;
    ctx.strokeStyle = withAlpha(g.color, 0.35 * (1 - u * 0.4));
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    ctx.lineWidth = 1.0 / scale;
    ctx.strokeStyle = withAlpha('#ffffff', 0.85 * (1 - u * 0.5));
    ctx.stroke();
    ctx.restore();

    // Leading-edge sparkle — sparks at the tip during the first half.
    if (u < 0.85) {
      ctx.save();
      for (const sp of g.sparks) {
        const t1 = Math.max(0, Math.min(1, eased + sp.offsetT * 0.4));
        const tx = sNode.x + (tNode.x - sNode.x) * t1;
        const ty = sNode.y + (tNode.y - sNode.y) * t1;
        // Perpendicular wobble for an organic feel.
        const dx = tNode.x - sNode.x;
        const dy = tNode.y - sNode.y;
        const len = Math.hypot(dx, dy) || 1;
        const px = -dy / len, py = dx / len;
        ctx.beginPath();
        ctx.arc(tx + px * sp.wobble * (1 - u), ty + py * sp.wobble * (1 - u), 1.2, 0, Math.PI * 2);
        ctx.fillStyle = withAlpha(g.color, 0.75 * (1 - u));
        ctx.fill();
      }
      ctx.restore();
    }
  }

  function paintWave(ctx, scale, w, age) {
    ctx.save();
    ctx.lineCap = 'round';
    for (const r of w.ripples) {
      const localAge = age - r.startMs;
      if (localAge < 0 || localAge > 900) continue;
      const u = localAge / 900;
      const sNode = state.byId.get(srcId(r.edge));
      const tNode = state.byId.get(tgtId(r.edge));
      if (!sNode || !tNode || sNode.x == null || tNode.x == null) continue;
      const ex = sNode.x + (tNode.x - sNode.x) * u;
      const ey = sNode.y + (tNode.y - sNode.y) * u;
      // Trailing tail — a short segment behind the leading head.
      const tailU = Math.max(0, u - 0.25);
      const tx = sNode.x + (tNode.x - sNode.x) * tailU;
      const ty = sNode.y + (tNode.y - sNode.y) * tailU;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(ex, ey);
      ctx.lineWidth = 2.4 / scale;
      ctx.strokeStyle = withAlpha(w.color, 0.55 * (1 - u));
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(ex, ey, 2.2, 0, Math.PI * 2);
      ctx.fillStyle = withAlpha(w.color, 0.85 * (1 - u));
      ctx.fill();
    }
    // Faint expanding ring at the root.
    const root = state.byId.get(w.rootId);
    if (root && root.x != null) {
      const u = age / THINK_WAVE_DURATION_MS;
      const r = 6 + u * 60;
      ctx.beginPath();
      ctx.arc(root.x, root.y, r, 0, Math.PI * 2);
      ctx.lineWidth = 1.2 / scale;
      ctx.strokeStyle = withAlpha(w.color, 0.35 * (1 - u));
      ctx.stroke();
    }
    ctx.restore();
  }

  // ── Loop / lifecycle ────────────────────────────────────────────────

  function attachHook() {
    if (attached) return;
    if (typeof fg.onRenderFramePost === 'function') {
      fg.onRenderFramePost(paint);
      attached = true;
    }
  }

  function loop() {
    if (!active) return;
    if (births.length || growths.length || waves.length) fg.refresh?.();
    requestAnimationFrame(loop);
  }

  return {
    start() {
      if (active) return;
      active = true;
      attachHook();
      requestAnimationFrame(loop);
    },
    stop() { active = false; },
    clear() {
      births.length = 0;
      growths.length = 0;
      waves.length = 0;
    },
    syncFromGraph,
    spawnBirth,
    spawnGrowth,
    spawnThinkWave,
    /** Reset the diff baseline — used after destroy/recreate of the renderer
     *  so we don't replay every node's birth animation on the next sync. */
    resetBaseline() {
      seenNodes.clear();
      seenEdges.clear();
      firstSync = true;
    },
    isActive() { return active; },
  };
}

function now() {
  return typeof performance !== 'undefined' && performance.now
    ? performance.now()
    : Date.now();
}

function withAlpha(color, a) {
  if (color.startsWith('rgba')) return color;
  if (color.startsWith('rgb')) {
    return color.replace('rgb(', 'rgba(').replace(')', `,${a})`);
  }
  const m = /^#?([0-9a-f]{6})$/i.exec(color);
  if (!m) return color;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
