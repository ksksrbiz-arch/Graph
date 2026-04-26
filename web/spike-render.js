// Spike-event rendering. For each `spike` event from the simulator we draw:
//   • a brief radial flash on the firing neuron
//   • a travelling pulse along every outgoing edge, tinted by the firing
//     neuron's region (motor, sensory, association, …).
//
// Drawing happens through force-graph's `onRenderFramePost` hook so we share
// the canvas + world transform with the graph view. The renderer keeps an
// internal RAF loop running so the canvas stays "alive" between force-graph
// repaints — without it, force-graph would only repaint when the simulation
// settled and pulses would freeze mid-flight.

import { regionForNode, styleForRegion } from './cortex.js';
import { srcId, tgtId } from './util.js';

const PULSE_DURATION_MS = 700;
const FLASH_DURATION_MS = 320;
const MAX_PULSES = 1500;
const MAX_FLASHES = 600;

export function createSpikeRenderer(fg, state) {
  const pulses = [];
  const flashes = [];
  let active = false;
  let attachedHook = false;

  function tintFor(neuronId) {
    const node = state.byId.get(neuronId);
    if (!node) return '#ffffff';
    const region = node.region || regionForNode(node);
    return styleForRegion(region).color;
  }

  function spawn(neuronId) {
    const t = now();
    const color = tintFor(neuronId);
    if (flashes.length >= MAX_FLASHES) flashes.shift();
    flashes.push({ neuronId, color, bornMs: t });
    const out = state.outgoing?.get(neuronId);
    if (!out) return;
    for (const edge of out) {
      if (pulses.length >= MAX_PULSES) pulses.shift();
      pulses.push({ edge, color, bornMs: t });
    }
  }

  function paint(ctx, _scale) {
    const t = now();
    for (let i = flashes.length - 1; i >= 0; i--) {
      const f = flashes[i];
      const age = t - f.bornMs;
      if (age >= FLASH_DURATION_MS) { flashes.splice(i, 1); continue; }
      const node = state.byId.get(f.neuronId);
      if (!node || node.x == null || node.y == null) continue;
      const a = 1 - age / FLASH_DURATION_MS;
      const r = 4 + age / 25;
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
      ctx.fillStyle = withAlpha(f.color, 0.45 * a);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(node.x, node.y, r * 0.55, 0, 2 * Math.PI);
      ctx.fillStyle = withAlpha('#ffffff', 0.55 * a);
      ctx.fill();
    }
    for (let i = pulses.length - 1; i >= 0; i--) {
      const p = pulses[i];
      const age = t - p.bornMs;
      if (age >= PULSE_DURATION_MS) { pulses.splice(i, 1); continue; }
      const e = p.edge;
      const sNode = state.byId.get(srcId(e));
      const tNode = state.byId.get(tgtId(e));
      if (!sNode || !tNode || sNode.x == null || tNode.x == null) continue;
      const u = age / PULSE_DURATION_MS;
      const x = sNode.x + (tNode.x - sNode.x) * u;
      const y = sNode.y + (tNode.y - sNode.y) * u;
      const fade = u < 0.15 ? u / 0.15 : 1 - (u - 0.15) / 0.85;
      ctx.beginPath();
      ctx.arc(x, y, 2.4, 0, 2 * Math.PI);
      ctx.fillStyle = withAlpha(p.color, 0.85 * fade);
      ctx.fill();
    }
  }

  function attachHook() {
    if (attachedHook) return;
    if (typeof fg.onRenderFramePost === 'function') {
      fg.onRenderFramePost(paint);
      attachedHook = true;
    }
  }

  function loop() {
    if (!active) return;
    if (pulses.length > 0 || flashes.length > 0) fg.refresh?.();
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
    clear() { pulses.length = 0; flashes.length = 0; },
    onSpike(neuronId) { if (active) spawn(neuronId); },
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
  const m = /^#?([0-9a-f]{6})$/i.exec(color);
  if (!m) return color;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
