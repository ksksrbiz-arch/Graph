// Ambient wireframe backdrop. A full-canvas overlay anchored behind the
// graph that draws a slow-drifting field of dots with line segments between
// nearby pairs — the look from the first reference photo where a brain is
// suggested by a halo of faintly-connected points. Independent of the
// graph data, so it animates even when the graph is empty or paused.
//
// The canvas is mounted into #view-graph (NOT #canvas) so it survives
// renderer rebuilds — `create2DRenderer` clears #canvas.innerHTML when it
// reinitialises. The canvas sits at z-index 0 with the force-graph canvas
// at z-index 1, producing the layered "halo behind the graph" look.

const PARTICLE_COUNT_DEFAULT = 110;
const LINK_DISTANCE = 110;
const DRIFT_SPEED = 0.018;
const PARTICLE_RADIUS = 1.3;

let canvas = null;
let ctx = null;
let dpr = 1;
let particles = [];
let raf = 0;
let running = false;
let host = null;
let onResize = null;

export function startBackdrop({ container } = {}) {
  if (running) return;
  host = container || document.getElementById('view-graph') || document.body;
  if (!host) return;

  canvas = document.createElement('canvas');
  canvas.className = 'brain-backdrop';
  canvas.style.cssText = [
    'position:absolute',
    'inset:0',
    'pointer-events:none',
    'z-index:0',
    'display:block',
    'mix-blend-mode:screen',
    'opacity:0.55',
  ].join(';');
  // Insert as the *first* child so the existing #canvas (z-index:1) renders
  // on top, but the canvas still respects #view-graph::before which provides
  // the radial gradient at z-index 0.
  host.insertBefore(canvas, host.firstChild);
  ctx = canvas.getContext('2d');

  resize();
  onResize = () => resize();
  window.addEventListener('resize', onResize);

  running = true;
  loop();
}

export function stopBackdrop() {
  running = false;
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  if (onResize) window.removeEventListener('resize', onResize);
  onResize = null;
  if (canvas?.parentElement) canvas.parentElement.removeChild(canvas);
  canvas = null;
  ctx = null;
  particles = [];
}

function resize() {
  if (!canvas) return;
  dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const w = host.clientWidth || window.innerWidth;
  const h = host.clientHeight || window.innerHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Re-seed the particle field whenever the viewport changes shape so we
  // never have a sparse strip after a resize.
  const target = particleCountFor(w, h);
  particles = [];
  for (let i = 0; i < target; i++) particles.push(spawn(w, h));
}

function particleCountFor(w, h) {
  // Scale by viewport area but cap at the default to avoid tanking weak
  // GPUs on giant monitors.
  const area = w * h;
  const scale = Math.min(1, area / (1280 * 720));
  return Math.max(40, Math.round(PARTICLE_COUNT_DEFAULT * scale));
}

function spawn(w, h) {
  return {
    x: Math.random() * w,
    y: Math.random() * h,
    vx: (Math.random() - 0.5) * DRIFT_SPEED * 60,
    vy: (Math.random() - 0.5) * DRIFT_SPEED * 60,
    seed: Math.random() * Math.PI * 2,
  };
}

function loop() {
  if (!running) return;
  raf = requestAnimationFrame(loop);
  if (document.hidden) return;
  if (!ctx || !canvas) return;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;

  ctx.clearRect(0, 0, w, h);

  // Soft radial vignette so the field reads as a brain-like halo, not a
  // uniform dot grid.
  const grad = ctx.createRadialGradient(w * 0.5, h * 0.5, 0, w * 0.5, h * 0.5, Math.max(w, h) * 0.7);
  grad.addColorStop(0,   'rgba(124,156,255,0.08)');
  grad.addColorStop(0.6, 'rgba(124,156,255,0.02)');
  grad.addColorStop(1,   'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // Drift + wrap.
  const t = performance.now() * 0.001;
  for (const p of particles) {
    p.x += p.vx * (1 / 60);
    p.y += p.vy * (1 / 60);
    if (p.x < -8) p.x = w + 8; else if (p.x > w + 8) p.x = -8;
    if (p.y < -8) p.y = h + 8; else if (p.y > h + 8) p.y = -8;
  }

  // Draw segments between any two particles within LINK_DISTANCE.
  // Inexpensive O(n²) is fine at n ≤ 110.
  ctx.lineWidth = 0.6;
  for (let i = 0; i < particles.length; i++) {
    const a = particles[i];
    for (let j = i + 1; j < particles.length; j++) {
      const b = particles[j];
      const dx = a.x - b.x, dy = a.y - b.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > LINK_DISTANCE * LINK_DISTANCE) continue;
      const d = Math.sqrt(d2);
      const k = 1 - d / LINK_DISTANCE;
      ctx.strokeStyle = `rgba(124,156,255,${(k * 0.18).toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }

  // Draw particles last with a faint twinkle.
  for (const p of particles) {
    const tw = 0.55 + Math.sin(t * 1.4 + p.seed) * 0.25;
    ctx.beginPath();
    ctx.arc(p.x, p.y, PARTICLE_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(184,210,255,${(0.55 * tw).toFixed(3)})`;
    ctx.fill();
  }
}
