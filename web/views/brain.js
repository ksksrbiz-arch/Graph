// Brain Insights view — live snapshot of the spiking layer the API maintains
// for this user. Connects to the /brain Socket.IO namespace, renders four
// panels:
//
//   1. Region activity histogram (sensory / memory / association / …)
//   2. Top pathways — strongest, fastest growing, fastest decaying
//   3. Pathway formation feed — synapses that just crossed the threshold
//   4. Connectome growth sparkline — neurons & synapses over the last hour
//
// The API base + userId come from the data attributes on #view-brain so a
// future build step can inject a JWT-aware base URL without touching this
// file.

import { el, fmtTime, escape, socketNamespaceUrl, shouldAttemptBrainSocket } from '../util.js';

const REGION_LABELS = {
  sensory: 'Sensory',
  memory: 'Memory',
  association: 'Association',
  executive: 'Executive',
  motor: 'Motor',
  limbic: 'Limbic',
};

const FALLBACK_USER_ID = 'local';
const EMPTY_ANIM_PARTICLE_COUNT = 42;
const EMPTY_ANIM_SEED_MULTIPLIER = 17.3;
const EMPTY_ANIM_SEED_OFFSET = 9.4;
const EMPTY_ANIM_BASE_ORBIT = 0.18;
const EMPTY_ANIM_ORBIT_STEP = 0.07;
const EMPTY_ANIM_BASE_SPEED = 0.00035;
const EMPTY_ANIM_SPEED_STEP = 0.00011;
const EMPTY_ANIM_BASE_SIZE = 0.9;
const EMPTY_ANIM_SIZE_STEP = 0.6;
const EMPTY_ANIM_MIN_DPR = 1;
const EMPTY_ANIM_MAX_DPR = 2;
const EMPTY_ANIM_RING_BASE_SPEED = 0.0009;
const EMPTY_ANIM_RING_SPEED_STEP = 0.00025;
const EMPTY_ANIM_RING_PHASE_STEP = Math.PI * 0.5;
const EMPTY_ANIM_RING_SWEEP = Math.PI * 1.6;

let socket = null;
let lastSummary = null;
let placeholderRaf = 0;
let placeholderState = null;

export function initBrainView() {
  const root = document.getElementById('view-brain');
  if (!root) return;
  renderShell(root);

  // Start the live feed when the user actually navigates to the view, and
  // disconnect when they leave to keep the rest of the SPA snappy.
  window.addEventListener('hashchange', () => maybeConnect());
  maybeConnect();
}

function maybeConnect() {
  const isActive = location.hash === '#/brain';
  if (isActive) ensureSocket();
  else disposeSocket();
}

function ensureSocket() {
  if (socket || typeof io === 'undefined') return;
  const config = window.GRAPH_CONFIG || {};
  if (!shouldAttemptBrainSocket(config.apiBaseUrl)) {
    setStatus('offline (no brain api configured for this host)');
    return;
  }
  const socketUrl = socketNamespaceUrl(config.apiBaseUrl, '/brain');
  const userId = config.brainUserId || FALLBACK_USER_ID;

  setStatus('connecting…');
  socket = io(socketUrl, {
    query: { userId },
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 500,
  });
  socket.on('connect', () => setStatus('live'));
  socket.on('disconnect', () => setStatus('disconnected'));
  socket.on('connect_error', (err) => setStatus(`offline (${err.message})`));
  socket.on('hello', (msg) => {
    if (!msg?.running) {
      setStatus('idle (start the brain via POST /api/v1/brain/start)');
    }
  });
  socket.on('insight', (summary) => {
    lastSummary = summary;
    renderSummary(summary);
  });
  socket.on('pathway', (evt) => {
    pushFormation(evt);
  });
  socket.on('spike', () => {
    bumpHeartbeat();
  });
}

function disposeSocket() {
  if (!socket) return;
  socket.disconnect();
  socket = null;
}

// ── DOM scaffolding ──

function renderShell(root) {
  const config = window.GRAPH_CONFIG || {};
  root.innerHTML = '';
  root.appendChild(
    el('div', { class: 'view-header' },
      el('h2', {}, 'Brain'),
      el('p', { class: 'view-sub' },
        'Live view of the spiking network the API is building from your knowledge graph. ',
        'Spikes light up regions; STDP strengthens (or prunes) pathways between concepts that fire together.',
      ),
      el('div', { class: 'brain-status', id: 'brain-status' }, '…'),
    ),
  );
  if (config.apiBaseUrl) {
    root.appendChild(el('p', { class: 'view-sub' }, `API endpoint: ${config.apiBaseUrl}`));
  }

  root.appendChild(
    el('section', { class: 'brain-empty-state', id: 'brain-empty-state' },
      el('div', { class: 'brain-empty-copy' },
        el('p', { class: 'brain-empty-kicker' }, 'Neural Core • Standby'),
        el('h3', {}, 'Waiting for live cognitive signals'),
        el('p', {},
          'The simulator is online, but no meaningful activity is available yet. ',
          'Once spikes, pathways, and growth metrics stream in, this display transitions to live telemetry.',
        ),
      ),
      el('canvas', {
        id: 'brain-empty-canvas',
        class: 'brain-empty-canvas',
        width: 980,
        height: 260,
        'aria-hidden': 'true',
      }),
    ),
  );

  const grid = el('div', { class: 'brain-grid' });

  grid.appendChild(panel('Region activity',
    'Spikes per second over the last 30s. Sensory dominates while a connector is mid-sync; memory and association rise during dream replay.',
    el('div', { class: 'region-bars', id: 'region-bars' }),
  ));

  grid.appendChild(panel('Top pathways',
    'Synapses with the strongest learned weight right now. Click "growing" to see which links are gaining ground; "decaying" to see what is being pruned.',
    el('div', { class: 'pathway-tabs' },
      tabButton('strongest', 'Strongest', true),
      tabButton('growing', 'Growing'),
      tabButton('decaying', 'Decaying'),
    ),
    el('ol', { class: 'pathway-list', id: 'pathway-list' }),
  ));

  grid.appendChild(panel('Pathway formation',
    'Each entry is a synapse that just crossed the formation threshold (0.55). New pathways are how the brain remembers that two ideas belong together.',
    el('ul', { class: 'formation-list', id: 'formation-list' }),
  ));

  grid.appendChild(panel('Connectome growth',
    'Neuron + synapse counts and mean synapse weight, sampled per minute.',
    el('div', { class: 'growth-stats', id: 'growth-stats' }),
    el('canvas', { id: 'growth-spark', width: 420, height: 80, class: 'growth-spark' }),
  ));

  root.appendChild(grid);
  syncEmptyState(null);

  // Tab switching for the pathways panel — purely view-side; data comes from
  // the next 'insight' tick.
  let pathwaySort = 'strongest';
  root.addEventListener('click', (e) => {
    const target = e.target;
    if (target instanceof HTMLElement && target.dataset.tab) {
      pathwaySort = target.dataset.tab;
      for (const t of root.querySelectorAll('.pathway-tabs button')) {
        t.classList.toggle('active', t.dataset.tab === pathwaySort);
      }
      if (lastSummary) renderPathways(lastSummary, pathwaySort);
    }
  });
  root.dataset.pathwaySort = 'strongest';
}

function panel(title, description, ...body) {
  return el('section', { class: 'brain-panel' },
    el('header', {},
      el('h3', {}, title),
      el('p', { class: 'panel-desc' }, description),
    ),
    el('div', { class: 'panel-body' }, ...body),
  );
}

function tabButton(id, label, active = false) {
  const btn = el('button', {
    type: 'button',
    'data-tab': id,
    class: active ? 'active' : '',
  }, label);
  return btn;
}

// ── render passes ──

function setStatus(text) {
  const node = document.getElementById('brain-status');
  if (node) node.textContent = text;
}

function renderSummary(summary) {
  syncEmptyState(summary);
  renderRegions(summary.regions || []);
  const sort = document.getElementById('view-brain')?.dataset.pathwaySort || 'strongest';
  renderPathways(summary, sort);
  renderFormations(summary.recentFormations || []);
  renderGrowth(summary.growth || []);
}

function renderRegions(regions) {
  const host = document.getElementById('region-bars');
  if (!host) return;
  host.innerHTML = '';
  const max = Math.max(1, ...regions.map((r) => r.rate));
  for (const r of regions) {
    const pct = Math.round((r.rate / max) * 100);
    const row = el('div', { class: 'region-row' },
      el('span', { class: 'region-name' }, REGION_LABELS[r.region] || r.region),
      el('div', { class: 'region-bar' },
        el('div', {
          class: 'region-bar-fill',
          style: { width: `${pct}%`, background: r.color || '#888' },
        }),
      ),
      el('span', { class: 'region-rate' }, `${r.rate.toFixed(1)}/s`),
    );
    host.appendChild(row);
  }
}

function renderPathways(summary, sort) {
  const list = document.getElementById('pathway-list');
  if (!list) return;
  const arr =
    sort === 'growing' ? summary.growingPathways :
    sort === 'decaying' ? summary.decayingPathways :
    summary.strongestPathways;
  list.innerHTML = '';
  if (!arr || arr.length === 0) {
    list.appendChild(el('li', { class: 'empty' }, 'No data yet — start the brain to see pathways.'));
    return;
  }
  for (const p of arr) {
    const deltaSign = p.delta > 0 ? '+' : '';
    const deltaClass = p.delta > 0 ? 'delta-up' : p.delta < 0 ? 'delta-down' : '';
    list.appendChild(el('li', {},
      el('span', { class: 'pathway-weight' }, p.weight.toFixed(2)),
      el('code', { class: 'pathway-edge' }, `${shortId(p.pre)} → ${shortId(p.post)}`),
      el('span', { class: `pathway-delta ${deltaClass}` }, `${deltaSign}${p.delta.toFixed(2)}`),
    ));
  }
}

function renderFormations(events) {
  const host = document.getElementById('formation-list');
  if (!host) return;
  host.innerHTML = '';
  if (events.length === 0) {
    host.appendChild(el('li', { class: 'empty' }, 'No new pathways formed yet.'));
    return;
  }
  for (const ev of events) {
    host.appendChild(el('li', {},
      el('time', {}, fmtTime(ev.formedAt)),
      el('code', {}, `${shortId(ev.pre)} → ${shortId(ev.post)}`),
      el('span', { class: 'formation-weight' }, `w=${ev.weight.toFixed(2)}`),
    ));
  }
}

function renderGrowth(samples) {
  const host = document.getElementById('growth-stats');
  if (host) {
    host.innerHTML = '';
    const last = samples[samples.length - 1];
    if (last) {
      host.appendChild(stat('neurons', last.neurons));
      host.appendChild(stat('synapses', last.synapses));
      host.appendChild(stat('mean weight', last.meanWeight.toFixed(2)));
    } else {
      host.appendChild(el('span', { class: 'empty' }, '—'));
    }
  }
  drawSparkline('growth-spark', samples);
}

function pushFormation(evt) {
  const host = document.getElementById('formation-list');
  if (!host) return;
  // Drop the empty placeholder if present.
  const empty = host.querySelector('.empty');
  if (empty) empty.remove();
  const item = el('li', { class: 'formation-new' },
    el('time', {}, fmtTime(evt.formedAt)),
    el('code', {}, `${shortId(evt.p)} → ${shortId(evt.q)}`),
    el('span', { class: 'formation-weight' }, `w=${(evt.w ?? 0).toFixed(2)}`),
  );
  host.prepend(item);
  while (host.children.length > 50) host.removeChild(host.lastChild);
  // Strip the highlight class after the CSS animation has had time to play.
  setTimeout(() => item.classList.remove('formation-new'), 1500);
}

function bumpHeartbeat() {
  const status = document.getElementById('brain-status');
  if (status && status.textContent !== 'live') status.textContent = 'live';
}

// ── helpers ──

function stat(label, value) {
  return el('div', { class: 'growth-stat' },
    el('div', { class: 'num' }, String(value)),
    el('div', { class: 'lbl' }, label),
  );
}

function shortId(id) {
  if (!id) return '?';
  return escape(String(id).slice(0, 8));
}

function drawSparkline(canvasId, samples) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (!samples || samples.length < 2) return;
  const max = Math.max(...samples.map((s) => s.synapses)) || 1;
  ctx.strokeStyle = '#7c9cff';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < samples.length; i++) {
    const x = (i / (samples.length - 1)) * (w - 4) + 2;
    const y = h - 2 - ((samples[i].synapses / max) * (h - 6));
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Mean weight as a faint secondary line on a 0–1 scale.
  ctx.strokeStyle = 'rgba(255, 212, 92, 0.6)';
  ctx.beginPath();
  for (let i = 0; i < samples.length; i++) {
    const x = (i / (samples.length - 1)) * (w - 4) + 2;
    const y = h - 2 - (samples[i].meanWeight * (h - 6));
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function hasRealData(summary) {
  if (!summary) return false;
  if ((summary.regions || []).length > 0) return true;
  if ((summary.strongestPathways || []).length > 0) return true;
  if ((summary.growingPathways || []).length > 0) return true;
  if ((summary.decayingPathways || []).length > 0) return true;
  if ((summary.recentFormations || []).length > 0) return true;
  if ((summary.growth || []).length > 0) return true;
  return false;
}

function syncEmptyState(summary) {
  const shell = document.getElementById('brain-empty-state');
  if (!shell) return;
  const show = !hasRealData(summary);
  shell.classList.toggle('hidden', !show);
  if (show) startEmptyAnimation();
  else stopEmptyAnimation();
}

function startEmptyAnimation() {
  const canvas = document.getElementById('brain-empty-canvas');
  if (!(canvas instanceof HTMLCanvasElement)) return;
  if (placeholderRaf) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const particles = Array.from({ length: EMPTY_ANIM_PARTICLE_COUNT }, (_, i) => ({
    seed: (i * EMPTY_ANIM_SEED_MULTIPLIER) + EMPTY_ANIM_SEED_OFFSET,
    orbit: EMPTY_ANIM_BASE_ORBIT + (i % 11) * EMPTY_ANIM_ORBIT_STEP,
    speed: EMPTY_ANIM_BASE_SPEED + (i % 9) * EMPTY_ANIM_SPEED_STEP,
    size: EMPTY_ANIM_BASE_SIZE + (i % 4) * EMPTY_ANIM_SIZE_STEP,
  }));

  placeholderState = {
    ctx,
    canvas,
    particles,
    start: performance.now(),
    w: 0,
    h: 0,
    dpr: EMPTY_ANIM_MIN_DPR,
    onResize: null,
  };

  const updateDpr = () => {
    if (!placeholderState) return;
    placeholderState.dpr = Math.max(
      EMPTY_ANIM_MIN_DPR,
      Math.min(EMPTY_ANIM_MAX_DPR, window.devicePixelRatio || EMPTY_ANIM_MIN_DPR),
    );
  };
  placeholderState.onResize = updateDpr;
  updateDpr();
  window.addEventListener('resize', updateDpr);

  const tick = (now) => {
    if (!placeholderState) return;
    const dpr = placeholderState.dpr;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(120, Math.floor((rect.width || canvas.width) * dpr));
    const height = Math.max(80, Math.floor((rect.height || canvas.height) * dpr));
    if (width !== placeholderState.w || height !== placeholderState.h) {
      placeholderState.w = width;
      placeholderState.h = height;
      canvas.width = width;
      canvas.height = height;
    }

    const { w, h } = placeholderState;
    const t = now - placeholderState.start;
    const mx = w * 0.5;
    const my = h * 0.5;
    const core = Math.min(w, h) * 0.14;

    ctx.clearRect(0, 0, w, h);

    const bg = ctx.createRadialGradient(mx, my, core * 0.3, mx, my, Math.max(w, h) * 0.65);
    bg.addColorStop(0, 'rgba(124,156,255,0.24)');
    bg.addColorStop(0.45, 'rgba(61,92,190,0.1)');
    bg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    const ringAlpha = 0.16 + (Math.sin(t * 0.0013) * 0.06);
    for (let i = 0; i < 4; i++) {
      const phase = (t * (EMPTY_ANIM_RING_BASE_SPEED + i * EMPTY_ANIM_RING_SPEED_STEP)) + (i * EMPTY_ANIM_RING_PHASE_STEP);
      ctx.strokeStyle = `rgba(166,201,255,${Math.max(0.05, ringAlpha - i * 0.03).toFixed(3)})`;
      ctx.lineWidth = Math.max(1, (2.2 - i * 0.35) * dpr * 0.5);
      ctx.beginPath();
      ctx.arc(mx, my, core + i * (core * 0.45) + Math.sin(phase) * (6 * dpr), phase * 0.4, phase * 0.4 + EMPTY_ANIM_RING_SWEEP);
      ctx.stroke();
    }

    const pulse = 0.72 + (Math.sin(t * 0.0024) * 0.2);
    const coreGlow = ctx.createRadialGradient(mx, my, 0, mx, my, core * 1.5);
    coreGlow.addColorStop(0, `rgba(198,222,255,${(0.48 * pulse).toFixed(3)})`);
    coreGlow.addColorStop(0.45, `rgba(124,156,255,${(0.34 * pulse).toFixed(3)})`);
    coreGlow.addColorStop(1, 'rgba(124,156,255,0)');
    ctx.fillStyle = coreGlow;
    ctx.beginPath();
    ctx.arc(mx, my, core * 1.5, 0, Math.PI * 2);
    ctx.fill();

    for (const p of placeholderState.particles) {
      const a = (t * p.speed) + p.seed;
      const r = core * (1 + p.orbit * 2.2);
      const x = mx + Math.cos(a) * r;
      const y = my + Math.sin(a * 1.35) * (r * 0.68);
      ctx.fillStyle = 'rgba(211,236,255,0.86)';
      ctx.beginPath();
      ctx.arc(x, y, p.size * dpr * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }

    placeholderRaf = requestAnimationFrame(tick);
  };

  placeholderRaf = requestAnimationFrame(tick);
}

function stopEmptyAnimation() {
  if (placeholderRaf) cancelAnimationFrame(placeholderRaf);
  if (placeholderState?.onResize) window.removeEventListener('resize', placeholderState.onResize);
  placeholderRaf = 0;
  placeholderState = null;
}
