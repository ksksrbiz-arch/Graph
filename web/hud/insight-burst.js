// Visual Spec Part 3 §12 — Insight Burst.
// 2.5 s sequence rendered on a transparent overlay canvas anchored above
// the graph view:
//
//   T+0ms    600ms shockwave (0→300px radius, opacity 1→0, 2px teal stroke)
//   T+100ms  24 particles explode from the centroid (80–200px range, 800ms)
//   T+300ms  1.8 s floating ".hud-panel" insight pill ("💡 …")
//
// All animation is driven by a single rAF loop (per §15 perf rules — no
// setInterval, no setTimeout for animation timing); particle count is hard
// capped (≤24 per burst). A burst auto-cleans its DOM/canvas state when its
// last animation segment finishes.

const SHOCKWAVE_DELAY = 0;
const SHOCKWAVE_DURATION = 600;
const SHOCKWAVE_MAX_R = 300;

const PARTICLES_DELAY = 100;
const PARTICLES_DURATION = 800;
const PARTICLE_COUNT = 24;
const PARTICLE_MIN_DIST = 80;
const PARTICLE_MAX_DIST = 200;
const PARTICLE_SIZE = 4;

const TEXT_DELAY = 300;
const TEXT_DURATION = 1800;
const TEXT_MAX_WIDTH = 320;

const TOTAL_DURATION = TEXT_DELAY + TEXT_DURATION; // 2100ms; spec says 2.5s
                                                   // total — extra 400ms is
                                                   // tail cleanup buffer.
const CLEANUP_BUFFER = 500;

let canvas = null;
let ctx = null;
let dpr = 1;
let activeBursts = []; // { startMs, x, y, color, textEl }
let raf = 0;

function ensureCanvas() {
  if (canvas) return canvas;
  const host = document.getElementById('canvas') || document.body;
  canvas = document.createElement('canvas');
  canvas.className = 'insight-burst-canvas';
  canvas.style.cssText = [
    'position:absolute',
    'inset:0',
    'pointer-events:none',
    'z-index:7',
    'display:block',
  ].join(';');
  host.appendChild(canvas);
  ctx = canvas.getContext('2d');
  resize();
  window.addEventListener('resize', resize);
  return canvas;
}

function resize() {
  if (!canvas) return;
  dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const host = canvas.parentElement;
  const w = host?.clientWidth || window.innerWidth;
  const h = host?.clientHeight || window.innerHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

/** Trigger an insight burst at host-relative (x, y). If x/y omitted, the
 *  burst centers on the canvas. `text` is the insight summary; if blank
 *  the floating pill is suppressed. */
export function triggerInsightBurst({ x, y, text, color } = {}) {
  ensureCanvas();
  const host = canvas.parentElement;
  const cx = Number.isFinite(x) ? x : (host?.clientWidth || 0) / 2;
  const cy = Number.isFinite(y) ? y : (host?.clientHeight || 0) / 2;
  const teal = getCssVar('--teal-core', '#00ffaa');

  const burst = {
    startMs: performance.now(),
    x: cx,
    y: cy,
    color: color || teal,
    text: String(text || '').trim(),
    textEl: null,
    particles: makeParticles(cx, cy),
    finished: false,
  };
  activeBursts.push(burst);

  // Spawn the floating insight DOM pill (positioned above the centroid).
  if (burst.text) {
    setTimeout(() => spawnInsightText(burst), TEXT_DELAY);
  }

  startLoop();
}

function makeParticles(cx, cy) {
  const arr = [];
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const angle = (i / PARTICLE_COUNT) * Math.PI * 2 + Math.random() * 0.2;
    const dist = PARTICLE_MIN_DIST + Math.random() * (PARTICLE_MAX_DIST - PARTICLE_MIN_DIST);
    arr.push({
      ox: cx, oy: cy,
      dx: Math.cos(angle) * dist,
      dy: Math.sin(angle) * dist,
    });
  }
  return arr;
}

function spawnInsightText(burst) {
  if (burst.finished) return;
  const host = canvas?.parentElement;
  if (!host) return;
  const el = document.createElement('div');
  el.className = 'insight-burst-text hud-panel';
  el.textContent = `💡 ${burst.text}`;
  el.style.cssText = [
    'position:absolute',
    `left:${burst.x}px`,
    `top:${burst.y}px`,
    'transform:translate(-50%, 0)',
    `max-width:${TEXT_MAX_WIDTH}px`,
    'padding:8px 12px',
    'font-family:var(--text-mono)',
    'font-size:12px',
    'color:var(--text-primary)',
    'pointer-events:none',
    'z-index:8',
    'opacity:0',
    'animation:insightTextFloat 1800ms ease-in-out forwards',
    'white-space:normal',
    'word-wrap:break-word',
  ].join(';');
  host.appendChild(el);
  burst.textEl = el;
  setTimeout(() => { try { el.remove(); } catch {} }, TEXT_DURATION + 100);
}

function startLoop() {
  if (raf) return;
  const step = (now) => {
    raf = 0;
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    let any = false;
    for (const b of activeBursts) {
      const t = now - b.startMs;
      if (t >= TOTAL_DURATION + CLEANUP_BUFFER) {
        b.finished = true;
        continue;
      }
      any = true;
      drawShockwave(b, t);
      drawParticles(b, t);
    }
    activeBursts = activeBursts.filter((b) => !b.finished);
    if (any) raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
}

function drawShockwave(b, t) {
  const start = SHOCKWAVE_DELAY;
  const end = SHOCKWAVE_DELAY + SHOCKWAVE_DURATION;
  if (t < start || t > end) return;
  const k = (t - start) / SHOCKWAVE_DURATION; // 0..1
  const eased = 1 - Math.pow(1 - k, 3); // ease-out cubic
  const r = eased * SHOCKWAVE_MAX_R;
  const alpha = 1 - k;
  ctx.save();
  ctx.beginPath();
  ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
  ctx.lineWidth = 2;
  ctx.strokeStyle = withAlpha(b.color, alpha);
  ctx.shadowColor = b.color;
  ctx.shadowBlur = 12;
  ctx.stroke();
  ctx.restore();
}

function drawParticles(b, t) {
  const start = PARTICLES_DELAY;
  const end = PARTICLES_DELAY + PARTICLES_DURATION;
  if (t < start || t > end) return;
  const k = (t - start) / PARTICLES_DURATION;
  const eased = 1 - Math.pow(1 - k, 2);
  const alpha = 1 - k;
  ctx.save();
  ctx.fillStyle = withAlpha(b.color, alpha);
  ctx.shadowColor = b.color;
  ctx.shadowBlur = 6;
  for (const p of b.particles) {
    const px = p.ox + p.dx * eased;
    const py = p.oy + p.dy * eased;
    ctx.beginPath();
    ctx.arc(px, py, PARTICLE_SIZE / 2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function withAlpha(color, alpha) {
  // Accept #rrggbb or rgba(...) — for #rrggbb append a hex alpha; otherwise
  // fall back to rgba() best-effort.
  const a = Math.max(0, Math.min(1, alpha));
  if (/^#[0-9a-f]{6}$/i.test(color)) {
    const ah = Math.round(a * 255).toString(16).padStart(2, '0');
    return `${color}${ah}`;
  }
  return color;
}

function getCssVar(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch { return fallback; }
}

// One-time keyframe injection — keeps the JS module self-contained without
// pulling another stylesheet just for the 1800ms float.
(function injectKeyframes() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('insight-burst-kf')) return;
  const style = document.createElement('style');
  style.id = 'insight-burst-kf';
  style.textContent = `
@keyframes insightTextFloat {
  0%   { opacity: 0; transform: translate(-50%, 0) }
  15%  { opacity: 1; transform: translate(-50%, -20px) }
  75%  { opacity: 1; transform: translate(-50%, -60px) }
  100% { opacity: 0; transform: translate(-50%, -80px) }
}`;
  document.head.appendChild(style);
})();
