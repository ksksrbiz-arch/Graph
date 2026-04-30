// Visual Spec Part 2 §7 — Stats Bar.
// Fixed-position 40px overlay inside #view-graph showing live chips:
//   NODES · LINKS · AUTONOMOUS · CONFIDENCE AVG · LAST THOUGHT · status dot
// + a marquee track on the right with the most recent insight text.
//
// Numeric chips animate from the previous value to the new value over
// 600ms via a single rAF loop (one loop per chip).

import { state, subscribe } from '../state.js';
import { srcId, tgtId, escape } from '../util.js';

const ROLL_MS = 600;

let lastInsightText = '';
let lastInsightAt = 0;
let statusState = 'idle';   // 'idle' | 'active' | 'thinking'
let statusTimer = 0;

const chipDefs = [
  { key: 'nodes',       label: 'NODES',       fmt: (n) => pad4(n) },
  { key: 'links',       label: 'LINKS',       fmt: (n) => pad4(n) },
  { key: 'autonomous',  label: 'AUTONOMOUS',  fmt: (n) => pad4(n) },
  { key: 'confidence',  label: 'CONFIDENCE AVG', fmt: (n) => n.toFixed(2) },
  { key: 'lastThought', label: 'LAST THOUGHT', fmt: (n, raw) => raw },
];

function pad4(n) {
  const v = Math.max(0, Math.round(n));
  return String(v).padStart(4, '0');
}

export function initStatsBar({ getBrainMode } = {}) {
  const root = document.getElementById('hud-stats-bar');
  if (!root) return null;

  // Static markup
  root.innerHTML = `
    ${chipDefs.map((c) => `
      <span class="chip" data-chip="${c.key}">
        <span class="k">${c.label}:</span>
        <span class="v" data-v="${c.key}">—</span>
      </span>
    `).join('')}
    <span class="marquee" aria-label="Last insight">
      <span class="track" id="stats-bar-marquee">no insight yet</span>
    </span>
    <span class="chip" data-chip="status">
      <span class="status-dot idle" id="stats-bar-dot"></span>
      <span class="v" id="stats-bar-status">IDLE</span>
    </span>
  `;
  root.classList.add('hud-panel-enter');

  const valueEls = new Map();
  for (const c of chipDefs) {
    valueEls.set(c.key, root.querySelector(`[data-v="${c.key}"]`));
  }
  const dotEl = root.querySelector('#stats-bar-dot');
  const statusTextEl = root.querySelector('#stats-bar-status');
  const marqueeEl = root.querySelector('#stats-bar-marquee');

  const lastValues = new Map();
  for (const c of chipDefs) lastValues.set(c.key, 0);

  function setChip(key, target, rawText) {
    const el = valueEls.get(key);
    if (!el) return;
    if (rawText !== undefined) {
      el.textContent = rawText;
      lastValues.set(key, target);
      return;
    }
    const from = Number(lastValues.get(key) || 0);
    const to = Number(target || 0);
    if (!Number.isFinite(to) || from === to) {
      const fmt = chipDefs.find((c) => c.key === key)?.fmt;
      el.textContent = fmt ? fmt(to) : String(to);
      lastValues.set(key, to);
      return;
    }
    const start = performance.now();
    const fmt = chipDefs.find((c) => c.key === key)?.fmt;
    function step(t) {
      const k = Math.min(1, (t - start) / ROLL_MS);
      const eased = 1 - Math.pow(1 - k, 3); // ease-out cubic
      const v = from + (to - from) * eased;
      el.textContent = fmt ? fmt(v) : String(Math.round(v));
      if (k < 1) requestAnimationFrame(step);
      else lastValues.set(key, to);
    }
    requestAnimationFrame(step);
  }

  function recompute() {
    const g = state.graph || { nodes: [], edges: [] };
    const nodes = g.nodes || [];
    const edges = g.edges || [];
    const autonomous = nodes.reduce((acc, n) => {
      const src = (n.source || n.metadata?.source || '').toLowerCase();
      if (n.autonomous === true || src === 'autonomous') return acc + 1;
      return acc;
    }, 0);
    let cTotal = 0, cN = 0;
    for (const n of nodes) {
      const c = n.confidence ?? n.metadata?.confidence;
      if (typeof c === 'number' && Number.isFinite(c)) { cTotal += c; cN += 1; }
    }
    const confidence = cN > 0 ? cTotal / cN : 0;

    setChip('nodes', nodes.length);
    setChip('links', edges.length);
    setChip('autonomous', autonomous);
    setChip('confidence', confidence);

    const last = lastInsightAt > 0 ? formatRelativeShort(Date.now() - lastInsightAt) : '—';
    setChip('lastThought', 0, last);
  }

  function setStatus(next) {
    if (next === statusState) return;
    statusState = next;
    dotEl.classList.remove('idle', 'active', 'thinking');
    dotEl.classList.add(next);
    statusTextEl.textContent = next.toUpperCase();
  }

  /** External hook: a new insight has been observed (autonomous brain
   *  cycle finished). Updates marquee + last-thought clock + status. */
  function pushInsight(text) {
    lastInsightText = String(text || '').trim();
    lastInsightAt = Date.now();
    if (lastInsightText) {
      marqueeEl.textContent = lastInsightText;
    }
    setStatus('thinking');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      setStatus(getBrainMode?.() === 'idle' ? 'idle' : 'active');
    }, 1200);
    recompute();
  }

  /** External hook: brain has spiked but no new insight (just neural
   *  activity). Pulses the dot to "active". */
  function markActive() {
    if (statusState === 'thinking') return;
    setStatus('active');
  }

  function markIdle() {
    setStatus('idle');
  }

  // Subscribe to graph-loaded so the chips update when data arrives.
  subscribe((reason) => {
    if (reason === 'graph-loaded' || reason === 'filters-changed') recompute();
  });

  // Tick the "last thought" relative clock every 30s so chips like "2m
  // ago" stay roughly in sync without flooding rAF.
  setInterval(() => {
    if (lastInsightAt > 0) {
      const last = formatRelativeShort(Date.now() - lastInsightAt);
      const el = valueEls.get('lastThought');
      if (el) el.textContent = last;
    }
  }, 30_000);

  recompute();
  setStatus('idle');

  return { pushInsight, markActive, markIdle, recompute };
}

function formatRelativeShort(ms) {
  if (ms < 0) return 'now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
