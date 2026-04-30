// Canvas overlay that renders glow halos + thought-particle streams on top
// of force-graph. We don't touch the existing renderer's nodeCanvasObject —
// instead we layer a transparent canvas above #canvas and project node
// positions via fg.graph2ScreenCoords().
//
// Scope: 2D only for v1. In 3D mode the overlay is mounted but stays blank
// because projecting world coords to screen requires the THREE.js camera
// pipeline and a different code path. The rest of the brain animation
// system still works in 3D — the panel still updates, particles are still
// tracked — they just aren't drawn until the projection lands.

const FALLBACK_NODE_RADIUS = 8;

export function createBrainOverlay({ container, getRenderer, animation }) {
  const canvas = document.createElement('canvas');
  canvas.className = 'brain-overlay-canvas';
  Object.assign(canvas.style, {
    position: 'absolute',
    inset: '0',
    pointerEvents: 'none',
    zIndex: '4',
  });
  container.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  let snap = animation.snapshot();
  const unsubscribe = animation.subscribe((s) => { snap = s; });

  let dpr = window.devicePixelRatio || 1;
  let rafId = 0;

  function resize() {
    const rect = container.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  function project(node, renderer) {
    if (!node || node.x == null || node.y == null) return null;
    const fg = renderer?.fg;
    if (renderer?.kind !== '2d' || !fg || typeof fg.graph2ScreenCoords !== 'function') {
      return null;
    }
    try {
      const p = fg.graph2ScreenCoords(node.x, node.y);
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
      return p;
    } catch {
      return null;
    }
  }

  function nodeIndex(renderer) {
    const fg = renderer?.fg;
    const data = fg?.graphData?.();
    if (!data || !Array.isArray(data.nodes)) return null;
    const map = new Map();
    for (const n of data.nodes) map.set(n.id, n);
    return map;
  }

  function render() {
    rafId = requestAnimationFrame(render);
    const renderer = getRenderer?.();
    if (!renderer || renderer.kind !== '2d') {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    const nodes = nodeIndex(renderer);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);

    if (!nodes) return;

    // Node glow halos
    for (const [nodeId, state] of snap.nodeStates) {
      if (state.glowIntensity <= 0 && state.heat <= 0) continue;
      const node = nodes.get(nodeId);
      if (!node) continue;
      const p = project(node, renderer);
      if (!p) continue;
      const glowColor = heatToColor(state.heat);
      const radius = (FALLBACK_NODE_RADIUS + state.glowIntensity * 18) * (state.scale || 1);
      const alpha = Math.max(state.glowIntensity, state.heat * 0.6);
      const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius);
      grad.addColorStop(0, hexAlpha(glowColor, alpha * 0.7));
      grad.addColorStop(1, hexAlpha(glowColor, 0));
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();
    }

    // Particles
    for (const particle of snap.particles) {
      const t = particle.progress;
      if (t < 0 || t > 1) continue;
      const from = nodes.get(particle.fromNodeId);
      const to = nodes.get(particle.toNodeId);
      if (!from || !to) continue;
      const a = project(from, renderer);
      const b = project(to, renderer);
      if (!a || !b) continue;

      // quadratic bezier with a perpendicular bow so streams arc instead of
      // sliding straight along the underlying edge
      const mx = (a.x + b.x) / 2 - (b.y - a.y) * 0.18;
      const my = (a.y + b.y) / 2 + (b.x - a.x) * 0.18;
      const x = (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * mx + t * t * b.x;
      const y = (1 - t) * (1 - t) * a.y + 2 * (1 - t) * t * my + t * t * b.y;

      const fade = t < 0.1 ? t * 10 : t > 0.9 ? (1 - t) * 10 : 1;
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.fillStyle = hexAlpha(particle.color, fade * 0.25);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fillStyle = hexAlpha(particle.color, fade);
      ctx.fill();
    }
  }
  rafId = requestAnimationFrame(render);

  return {
    destroy() {
      cancelAnimationFrame(rafId);
      try { ro.disconnect(); } catch {}
      try { unsubscribe(); } catch {}
      try { canvas.remove(); } catch {}
    },
  };
}

function heatToColor(heat) {
  if (heat < 0.33) return '#00d4ff';
  if (heat < 0.66) return '#ffaa00';
  return '#ff4444';
}

function hexAlpha(hex, alpha) {
  const a = Math.max(0, Math.min(1, alpha));
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
