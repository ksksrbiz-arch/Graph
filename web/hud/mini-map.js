// Visual Spec Part 2 §10 — Mini-map.
// 160×120 canvas, top-down 2D projection of all node positions. Type-coloured
// 2px circles. A cyan rectangle shows the main view's current viewport
// (best-effort, because the underlying 2D/3D renderers expose different
// camera APIs). Click → pan main camera to that world position.

import { state, subscribe } from '../state.js';
import { colorForType } from '../util.js';

const CSS_W = 160;
const CSS_H = 120;
const NODE_R = 2;
const PAD = 6;

export function initMiniMap({ getRenderer } = {}) {
  const root = document.getElementById('hud-mini-map');
  if (!root) return null;
  const canvas = root.querySelector('canvas');
  if (!canvas) return null;

  const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  canvas.width = CSS_W * dpr;
  canvas.height = CSS_H * dpr;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.scale(dpr, dpr);

  let raf = 0;

  function nodeColor(n) {
    return colorForType(n.type);
  }

  /** Returns { ox, oy, scale } mapping world coords -> canvas pixels. */
  function bounds(nodes) {
    if (nodes.length === 0) return null;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of nodes) {
      const x = n.x, y = n.y;
      if (typeof x !== 'number' || typeof y !== 'number') continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return null;
    const w = Math.max(1, maxX - minX);
    const h = Math.max(1, maxY - minY);
    const sx = (CSS_W - PAD * 2) / w;
    const sy = (CSS_H - PAD * 2) / h;
    const scale = Math.min(sx, sy);
    const ox = PAD - minX * scale + ((CSS_W - PAD * 2) - w * scale) / 2;
    const oy = PAD - minY * scale + ((CSS_H - PAD * 2) - h * scale) / 2;
    return { ox, oy, scale, minX, maxX, minY, maxY };
  }

  function draw() {
    raf = 0;
    const nodes = state.graph?.nodes || [];
    ctx.clearRect(0, 0, CSS_W, CSS_H);

    // Background tint matches glass panel.
    ctx.fillStyle = 'rgba(4, 13, 20, 0.55)';
    ctx.fillRect(0, 0, CSS_W, CSS_H);

    const b = bounds(nodes);
    if (!b) return;

    // Nodes
    for (const n of nodes) {
      const x = n.x, y = n.y;
      if (typeof x !== 'number' || typeof y !== 'number') continue;
      const px = b.ox + x * b.scale;
      const py = b.oy + y * b.scale;
      ctx.beginPath();
      ctx.arc(px, py, NODE_R, 0, Math.PI * 2);
      ctx.fillStyle = nodeColor(n);
      ctx.globalAlpha = 0.85;
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Camera viewport rectangle (best-effort).
    const rect = currentViewportRect(getRenderer?.(), b);
    if (rect) {
      ctx.strokeStyle = 'rgba(0, 212, 255, 0.85)';
      ctx.lineWidth = 1;
      ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w, rect.h);
      ctx.fillStyle = 'rgba(0, 212, 255, 0.08)';
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    }
  }

  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(draw);
  }

  // Click → pan main camera.
  root.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const nodes = state.graph?.nodes || [];
    const b = bounds(nodes);
    if (!b) return;
    const wx = (cx - b.ox) / b.scale;
    const wy = (cy - b.oy) / b.scale;
    const r = getRenderer?.();
    if (r && typeof r.centerOn === 'function') {
      r.centerOn({ x: wx, y: wy, z: 0 }, 500);
    }
  });

  subscribe((reason) => {
    if (reason === 'graph-loaded' || reason === 'filters-changed') schedule();
  });

  // Continuous redraw while the simulation is settling — d3-force keeps
  // mutating x/y, so a steady ~10fps loop keeps the dots in sync without
  // burning CPU.
  setInterval(schedule, 100);

  schedule();

  return { redraw: schedule };
}

function currentViewportRect(renderer, b) {
  if (!renderer || !b) return null;
  const fg = renderer.fg;
  // 2D force-graph: zoom() returns scale, centerAt() returns world center.
  if (renderer.kind === '2d' && fg && typeof fg.zoom === 'function' && typeof fg.centerAt === 'function') {
    try {
      const zoom = fg.zoom();
      const c = fg.centerAt();
      const containerRect = fg.width && fg.height
        ? { w: fg.width(), h: fg.height() }
        : { w: 0, h: 0 };
      if (!zoom || !c) return null;
      const halfWWorld = (containerRect.w / 2) / zoom;
      const halfHWorld = (containerRect.h / 2) / zoom;
      const x0 = b.ox + (c.x - halfWWorld) * b.scale;
      const y0 = b.oy + (c.y - halfHWorld) * b.scale;
      const w = Math.max(2, halfWWorld * 2 * b.scale);
      const h = Math.max(2, halfHWorld * 2 * b.scale);
      // Clamp to canvas
      return clampRect({ x: x0, y: y0, w, h });
    } catch { return null; }
  }
  // 3D/4D: approximate using camera distance — show a centered rectangle
  // sized inversely to camera distance.
  if (fg && typeof fg.camera === 'function') {
    try {
      const cam = fg.camera();
      const dist = cam.position.length ? cam.position.length() : 200;
      const k = Math.max(0.15, Math.min(0.85, 200 / Math.max(1, dist)));
      const w = (CSS_W - PAD * 2) * k;
      const h = (CSS_H - PAD * 2) * k;
      return clampRect({ x: (CSS_W - w) / 2, y: (CSS_H - h) / 2, w, h });
    } catch { return null; }
  }
  return null;
}

function clampRect(r) {
  const x = Math.max(0, Math.min(CSS_W - 2, r.x));
  const y = Math.max(0, Math.min(CSS_H - 2, r.y));
  const w = Math.max(2, Math.min(CSS_W - x, r.w));
  const h = Math.max(2, Math.min(CSS_H - y, r.h));
  return { x, y, w, h };
}
