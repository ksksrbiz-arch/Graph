// Visual Spec Part 2 §9 — Brain Control Panel.
// Bottom-left collapsible panel with:
//   • Start/Pause loop  +  Force Cycle
//   • Cycle interval slider (1–60 minutes)
//   • Quality tier buttons (PERF | BAL | ULTRA) — wired to bloom strength
//   • Last 3 insights, freshest first
//   • A notice line if the GPU guard recommended a tier downgrade.

import { state, setConfig } from '../state.js';
import { escape } from '../util.js';
import {
  QUALITY_TIERS, getQualityTier, setQualityTier,
  ensureQualityTierInit, getGpuStatus, defaultTier,
} from './quality.js';

const MAX_INSIGHTS = 3;
const MIN_INTERVAL = 1;
const MAX_INTERVAL = 60;
const DEFAULT_INTERVAL = 5;

export function initBrainControls({
  onStart, onPause, onForceCycle, getMode,
} = {}) {
  const root = document.getElementById('hud-brain-controls');
  if (!root) return null;

  ensureQualityTierInit();
  if (state.config.cycleIntervalMin == null) {
    state.config.cycleIntervalMin = DEFAULT_INTERVAL;
  }

  root.innerHTML = `
    <div class="bc-head" role="button" tabindex="0" aria-expanded="true">
      <span><span class="glyph">⬡</span> BRAIN CONTROLS</span>
      <span class="arrow">▾</span>
    </div>
    <div class="bc-body">
      <div class="bc-row">
        <button type="button" class="bc-btn" data-action="toggle">▶ START LOOP</button>
        <button type="button" class="bc-btn" data-action="cycle">⚡ FORCE CYCLE</button>
      </div>
      <div class="bc-slider">
        <label>
          <span>CYCLE INTERVAL</span>
          <span class="v" data-v="interval">${DEFAULT_INTERVAL} min</span>
        </label>
        <input type="range" min="${MIN_INTERVAL}" max="${MAX_INTERVAL}" step="1"
               value="${state.config.cycleIntervalMin}" data-input="interval" />
      </div>
      <div class="bc-slider">
        <label><span>QUALITY</span><span class="v" data-v="quality">—</span></label>
        <div class="bc-row q-row" role="tablist" aria-label="Quality tier">
          ${QUALITY_TIERS.map((t) => `
            <button type="button" class="bc-btn" data-quality="${t}">${labelFor(t)}</button>
          `).join('')}
        </div>
      </div>
      <div class="bc-notice" data-role="notice" hidden></div>
      <div>
        <div class="bc-slider"><label><span>LAST INSIGHTS</span></label></div>
        <ul class="bc-insights" data-role="insights">
          <li class="empty">No insights yet — click <em>Force Cycle</em> to seed one.</li>
        </ul>
      </div>
    </div>
  `;
  root.classList.add('hud-panel-enter', 'open');

  const head = root.querySelector('.bc-head');
  head.addEventListener('click', () => {
    root.classList.toggle('open');
    head.setAttribute('aria-expanded', root.classList.contains('open') ? 'true' : 'false');
  });
  head.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); head.click(); }
  });

  const toggleBtn = root.querySelector('[data-action="toggle"]');
  const cycleBtn = root.querySelector('[data-action="cycle"]');

  // The toggle reflects the user's *intent* (state.config.spikes) rather than
  // the brain client's current mode. brain.mode lags behind clicks because:
  //   1. The brain client is null until rebuildRenderer() runs (after the
  //      first graph load), so before then mode is always 'idle' and the
  //      label would never flip — leaving Start/Pause looking dead.
  //   2. Even after the brain exists, start() goes through an async
  //      'starting' phase, so basing the label on mode causes flicker.
  // spikes=true means "the user wants the loop on"; that's what the label
  // should show.
  function isRunning() {
    if (state.config.spikes === false) return false;
    if (state.config.spikes === true) return true;
    return (getMode?.() ?? 'idle') !== 'idle';
  }
  function reflectToggle() {
    const running = isRunning();
    toggleBtn.textContent = running ? '⏸ PAUSE' : '▶ START LOOP';
    toggleBtn.classList.toggle('active', running);
  }

  toggleBtn.addEventListener('click', () => {
    if (isRunning()) onPause?.();
    else onStart?.();
    reflectToggle();
  });

  cycleBtn.addEventListener('click', () => {
    onForceCycle?.();
  });

  // Cycle interval slider
  const intervalInput = root.querySelector('[data-input="interval"]');
  const intervalLabel = root.querySelector('[data-v="interval"]');
  intervalInput.addEventListener('input', () => {
    const v = Number(intervalInput.value);
    intervalLabel.textContent = `${v} min`;
    setConfig({ cycleIntervalMin: v });
  });
  intervalLabel.textContent = `${state.config.cycleIntervalMin} min`;

  // Quality buttons
  const qButtons = root.querySelectorAll('[data-quality]');
  qButtons.forEach((b) => {
    b.addEventListener('click', () => setQualityTier(b.dataset.quality));
  });
  function reflectQuality() {
    const t = getQualityTier();
    qButtons.forEach((b) => b.classList.toggle('active', b.dataset.quality === t));
    const lbl = root.querySelector('[data-v="quality"]');
    if (lbl) lbl.textContent = labelFor(t);
  }
  reflectQuality();

  // GPU guard notice (spec §5)
  const gpu = getGpuStatus();
  const noticeEl = root.querySelector('[data-role="notice"]');
  if (gpu.weak && noticeEl) {
    noticeEl.hidden = false;
    noticeEl.textContent = `⚠ ${gpu.reason}. Defaulting to ${labelFor(defaultTier())}.`;
  }

  // Insights list
  const insights = [];
  const insightsEl = root.querySelector('[data-role="insights"]');
  function renderInsights() {
    if (insights.length === 0) {
      insightsEl.innerHTML = `<li class="empty">No insights yet — click <em>Force Cycle</em> to seed one.</li>`;
      return;
    }
    insightsEl.innerHTML = insights.slice(0, MAX_INSIGHTS).map((it) => `
      <li><span class="ts">[${escape(it.ts)}]</span><span class="tx">${escape(it.text)}</span></li>
    `).join('');
  }
  function pushInsight(text) {
    const t = String(text || '').trim();
    if (!t) return;
    const trimmed = t.length > 60 ? `${t.slice(0, 59)}…` : t;
    insights.unshift({ ts: timestamp(), text: trimmed });
    if (insights.length > MAX_INSIGHTS) insights.length = MAX_INSIGHTS;
    renderInsights();
  }

  // Re-reflect when config changes (e.g. quality tier set elsewhere).
  // Subscriber lives in app.js so we just expose a hook.
  function syncFromState() {
    reflectQuality();
    reflectToggle();
  }

  reflectToggle();

  return { pushInsight, syncFromState };
}

function labelFor(tier) {
  if (tier === 'perf') return 'PERF';
  if (tier === 'balanced') return 'BAL';
  if (tier === 'ultra') return 'ULTRA';
  return tier.toUpperCase();
}

function timestamp() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}
