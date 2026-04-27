// Visual Spec Part 3 §13 — Boot Screen.
// Full-screen overlay shown immediately on app start. Auto-dismisses when
// the first `graph-loaded` event fires or after 3 s max, whichever comes
// first. All animation timing uses requestAnimationFrame / setTimeout for
// state transitions only — no setInterval (per §15 perf rules).

import { subscribe } from '../state.js';

const MAX_BOOT_MS = 3000;
const APP_NAME = 'GRAPH BRAIN';
const CHAR_DELAY_MS = 50;
const LINE_STAGGER_MS = 150;
const FADE_MS = 400;

const BOOT_LINES = [
  { label: 'INITIALIZING NEURAL SUBSTRATE', drives: 'instant' },
  { label: 'LOADING GRAPH DATA',            drives: 'graph'   },
  { label: 'CALIBRATING FORCE SIMULATION',  drives: 'instant' },
  { label: 'CONNECTING TO BRAIN LOOP',      drives: 'instant' },
];

let mounted = false;
let dismissed = false;
let unsubscribe = null;
let dismissTimer = 0;
let progressRaf = 0;

/** Show the boot screen and start animating it. Idempotent. */
export function showBootScreen() {
  if (mounted) return;
  mounted = true;

  const root = document.createElement('div');
  root.className = 'boot-screen';
  root.id = 'boot-screen';
  root.setAttribute('aria-label', 'Booting Graph Brain');
  root.innerHTML = `
    <div class="boot-hex"><div class="core"></div></div>
    <div class="boot-name" aria-label="${APP_NAME}">
      ${APP_NAME.split('').map((c) => `<span class="ch">${c === ' ' ? '&nbsp;' : escapeChar(c)}</span>`).join('')}
    </div>
    <div class="boot-log" role="log">
      ${BOOT_LINES.map((l, i) => `
        <div class="line" data-i="${i}" data-drives="${l.drives}">
          <span class="lbl">${escapeChar(l.label)}…</span>
          <span class="bar"><span class="fill"></span></span>
          <span class="status">…</span>
        </div>
      `).join('')}
    </div>
  `;
  document.body.appendChild(root);

  // Reveal app-name characters one at a time.
  const chars = root.querySelectorAll('.boot-name .ch');
  chars.forEach((el, i) => {
    setTimeout(() => el.classList.add('on'), i * CHAR_DELAY_MS);
  });

  // Stagger boot log lines.
  const lines = Array.from(root.querySelectorAll('.boot-log .line'));
  lines.forEach((el, i) => {
    setTimeout(() => {
      el.classList.add('on');
      // Lines that don't depend on real progress fill themselves over 500ms.
      if (el.dataset.drives === 'instant') simulateLine(el, 500);
    }, i * LINE_STAGGER_MS);
  });

  // The "graph data" line is driven by the actual fetch progress, exposed
  // via window.__graphBootProgress (0..1). We poll it via rAF; if it never
  // resolves we still fill the bar by the time MAX_BOOT_MS elapses.
  const graphLine = lines.find((el) => el.dataset.drives === 'graph');
  if (graphLine) startGraphProgress(graphLine);

  // Hard timeout dismissal so we never strand the user behind the splash.
  dismissTimer = setTimeout(() => dismissBootScreen(), MAX_BOOT_MS);

  // Subscribe to graph-loaded so we dismiss as soon as data lands.
  unsubscribe = subscribe((reason) => {
    if (reason === 'graph-loaded') {
      finishGraphProgress();
      // Allow a tiny grace period so the bar visually fills before fade.
      setTimeout(() => dismissBootScreen(), 250);
    }
  });
}

/** Force-dismiss the boot screen and clean up all listeners/timers. */
export function dismissBootScreen() {
  if (!mounted || dismissed) return;
  dismissed = true;
  const root = document.getElementById('boot-screen');
  if (!root) return;
  root.classList.add('hide');
  if (dismissTimer) { clearTimeout(dismissTimer); dismissTimer = 0; }
  if (progressRaf)  { cancelAnimationFrame(progressRaf); progressRaf = 0; }
  if (unsubscribe)  { try { unsubscribe(); } catch {} unsubscribe = null; }
  setTimeout(() => { try { root.remove(); } catch {} }, FADE_MS + 50);
}

/** Helper for app code to push fetch progress (0..1) into the boot screen. */
export function reportBootProgress(p) {
  const v = Math.max(0, Math.min(1, Number(p) || 0));
  window.__graphBootProgress = v;
}

// ── Internals ───────────────────────────────────────────────────────────────

function escapeChar(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function simulateLine(el, durationMs) {
  const fill = el.querySelector('.fill');
  const status = el.querySelector('.status');
  if (!fill || !status) return;
  const start = performance.now();
  function step(t) {
    const k = Math.min(1, (t - start) / durationMs);
    fill.style.width = `${(k * 100).toFixed(1)}%`;
    status.textContent = k < 1 ? `${Math.round(k * 100)}%` : 'OK';
    if (k < 1) requestAnimationFrame(step);
    else el.classList.add('done');
  }
  requestAnimationFrame(step);
}

function startGraphProgress(el) {
  const fill = el.querySelector('.fill');
  const status = el.querySelector('.status');
  if (!fill || !status) return;
  let finished = false;
  el.__finish = () => {
    finished = true;
    fill.style.width = '100%';
    status.textContent = 'OK';
    el.classList.add('done');
  };
  function tick() {
    if (finished || dismissed) { progressRaf = 0; return; }
    const p = Number(window.__graphBootProgress);
    if (Number.isFinite(p) && p > 0) {
      const pct = Math.max(0, Math.min(99, Math.round(p * 100)));
      fill.style.width = `${pct}%`;
      status.textContent = `${pct}%`;
    }
    progressRaf = requestAnimationFrame(tick);
  }
  progressRaf = requestAnimationFrame(tick);
}

function finishGraphProgress() {
  const el = document.querySelector('.boot-log .line[data-drives="graph"]');
  if (el && typeof el.__finish === 'function') el.__finish();
}
