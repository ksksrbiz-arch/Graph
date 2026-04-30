// Graph view orchestrator. Owns the renderer (2D/3D/4D), UI panels and
// context menus, the brain/spike client, and the live tuning loop. Calls
// down into the renderer module appropriate for the current dimension.

import {
  state, subscribe, setSelected, setFocusRoot, setHovered,
  setMinEdgeWeight, toggleFilterType, visibleNodeIds, setConfig, setDimensions,
} from '../state.js';
import { colorForType, escape, fmtDate, srcId, tgtId, truncate, el } from '../util.js';
import { regionForNode, styleForRegion } from '../cortex.js';
import { createBrainClient } from '../brain.js';
import { createBrainAnimation } from '../brain-animation.js';
import { createGraphLive } from '../graph-live.js';
import { createIngestPanel } from '../ingest-panel.js';
import { create2DRenderer } from './graph-2d.js';
import { create3DRenderer } from './graph-3d.js';
import { createBrainOverlay } from './brain-overlay.js';
import { startBackdrop } from '../brain-backdrop.js';
import { mountBrainPreview } from '../brain-preview.js';
import { initStatsBar } from '../hud/stats-bar.js';
import { initBrainControls } from '../hud/brain-controls.js';
import { initMiniMap } from '../hud/mini-map.js';
import { initHoloCursor } from '../hud/holo-cursor.js';
import { ensureQualityTierInit } from '../hud/quality.js';
import { triggerInsightBurst } from '../hud/insight-burst.js';

let renderer = null;
let brain = null;
let regionForce = null; // d3-force callback installed for region clustering
let lastSpikeAt = 0;
let spikeCount1s = 0;
let brainAnimation = null;
let brainOverlay = null;
let graphLive = null;
let ingestPanel = null;
let statsBarApi = null;
let brainControlsApi = null;

export function initGraphView() {
  const canvas = document.getElementById('canvas');

  document.getElementById('fit-btn').addEventListener('click', () => renderer?.fit(500, 60));
  document.getElementById('zoom-in').addEventListener('click', () => renderer?.zoomIn());
  document.getElementById('zoom-out').addEventListener('click', () => renderer?.zoomOut());
  document.getElementById('reset-focus').addEventListener('click', clearFocus);
  document.getElementById('focus-banner-close').addEventListener('click', clearFocus);

  const weightSlider = document.getElementById('edge-weight');
  weightSlider.addEventListener('input', () => {
    document.getElementById('edge-weight-val').textContent = Number(weightSlider.value).toFixed(2);
    setMinEdgeWeight(Number(weightSlider.value));
  });

  const regionSlider = document.getElementById('region-pull');
  regionSlider.addEventListener('input', () => {
    const v = Number(regionSlider.value);
    document.getElementById('region-pull-val').textContent = v.toFixed(2);
    setConfig({ regionClustering: v });
    const tw = document.getElementById('cfg-region');
    const twv = document.getElementById('cfg-region-val');
    if (tw) tw.value = String(v);
    if (twv) twv.textContent = v.toFixed(2);
  });

  document.querySelectorAll('.dim-switch button').forEach((b) => {
    b.addEventListener('click', () => {
      const d = Number(b.dataset.dim);
      setDimensions(d);
    });
  });

  const brainBtn = document.getElementById('brain-link');
  brainBtn.addEventListener('click', () => {
    setConfig({ spikes: !(state.config.spikes !== false) });
  });

  document.getElementById('panel-close').addEventListener('click', () => setSelected(null));
  document.getElementById('panel-action-trace').addEventListener('click', () => {
    if (state.selectedId) setFocusRoot(state.selectedId);
  });
  document.getElementById('panel-action-remove').addEventListener('click', () => {
    if (!state.selectedId) return;
    // "Remove" = hide from the current view by toggling its type filter
    // off. Cheaper than mutating the source data and reversible from the
    // type filter UI.
    const n = state.byId.get(state.selectedId);
    if (n) toggleFilterType(n.type, false);
    setSelected(null);
  });
  document.getElementById('panel-action-pin').addEventListener('click', () => {
    if (!state.selectedId) return;
    const n = state.byId.get(state.selectedId);
    if (!n) return;
    // Toggle pinned state by fixing the node at its current coordinates.
    if (n.fx == null && n.fy == null) {
      n.fx = n.x; n.fy = n.y; if (n.z != null) n.fz = n.z;
      n.__pinned = true;
    } else {
      delete n.fx; delete n.fy; if (!fourDActive()) delete n.fz;
      n.__pinned = false;
    }
    document.getElementById('panel-action-pin').classList.toggle('active', !!n.__pinned);
    renderer?.refresh?.();
  });

  canvas.addEventListener('click', (e) => {
    if (e.target.tagName === 'CANVAS') closeContextMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeContextMenu();
      if (state.focusRootId) clearFocus();
      else if (state.selectedId) setSelected(null);
    } else if (e.key === 'f' && !isTyping(e.target)) {
      renderer?.fit(500, 60);
    } else if (e.key === '2' && !isTyping(e.target)) {
      setDimensions(2);
    } else if (e.key === '3' && !isTyping(e.target)) {
      setDimensions(3);
    } else if (e.key === '4' && !isTyping(e.target)) {
      setDimensions(4);
    }
  });

  reflectModeButtons();
  reflectBrainButton();
  startHud();
  setupBrainAnimationPipeline();

  // Ambient wireframe backdrop — sits behind the force-graph canvas and
  // gives the graph the "brain in a halo" feel from the reference photos.
  // Mounted on #view-graph so it survives renderer rebuilds (the renderer
  // clears #canvas.innerHTML on each setup).
  try { startBackdrop({ container: document.getElementById('view-graph') }); } catch {}

  // Cortex thinking events — the cortex view dispatches these on
  // `window` whenever a /think request starts/ends so the graph can render
  // a BFS ripple across the network for the duration of reasoning. When
  // the live graph has too little data to produce a meaningful ripple, we
  // mount the looping preview animation instead so the user sees what
  // thinking *will* look like once they ingest content.
  window.addEventListener('cortex-thinking-start', (e) => {
    if (!hasEnoughDataForThinking()) {
      showThinkFallback();
      return;
    }
    const rootId = e?.detail?.rootId
      || state.selectedId
      || state.focusRootId
      || null;
    renderer?.thinkWave?.(rootId);
  });
  window.addEventListener('cortex-thinking-tick', (e) => {
    if (!hasEnoughDataForThinking()) return;
    const rootId = e?.detail?.rootId
      || state.selectedId
      || state.focusRootId
      || null;
    renderer?.thinkWave?.(rootId, e?.detail?.color);
  });
  window.addEventListener('cortex-thinking-end', () => {
    hideThinkFallback();
  });

  // Visual Spec Part 2 §5/§7/§9/§10/§11: HUD overlays. These mount into
  // anchor elements declared in index.html (#hud-stats-bar,
  // #hud-brain-controls, #hud-mini-map, #holo-cursor) and stay live for
  // the rest of the session.
  ensureQualityTierInit();
  initHoloCursor();
  statsBarApi = initStatsBar({ getBrainMode: () => brain?.mode || 'idle' });
  brainControlsApi = initBrainControls({
    getMode: () => brain?.mode || 'idle',
    onStart: () => {
      setConfig({ spikes: true });
      // setConfig triggers applyConfig() which calls brain.start() if idle.
      // No need to call brain.start() here directly — doing so would create
      // two concurrent start() calls before the first one can update the mode.
    },
    onPause: () => {
      setConfig({ spikes: false });
      brain?.stop();
    },
    onForceCycle: () => {
      // Without a real cognitive cycle we approximate "force a cycle" by
      // stimulating a random node and broadcasting an insight tick to the
      // HUD so users get visual feedback. Even if the graph hasn't loaded
      // yet (no nodes / brain still null), we still emit the insight + burst
      // so the button feels responsive instead of silently no-op'ing.
      const nodes = state.graph?.nodes || [];
      const pick = nodes.length ? nodes[Math.floor(Math.random() * nodes.length)] : null;
      const text = pick
        ? `forced spike on “${truncate(pick.label || pick.id, 40)}”`
        : 'forced cycle (load a graph to see spikes)';
      brainControlsApi?.pushInsight(text);
      statsBarApi?.pushInsight(text);
      // Visual Spec Part 3 §12 — trigger the insight burst at the canvas
      // center; it draws on its own overlay canvas above the graph.
      triggerInsightBurst({ text });
      // Ensure the brain is running so the spike animates across the graph.
      // If the brain was paused, start it before injecting the stimulus.
      if (brain && pick) {
        if (brain.mode === 'idle') {
          // Only stimulate if the brain successfully entered a running mode
          // (stop() called mid-start would leave mode 'idle' and localSim null).
          brain.start().then(() => { if (brain.mode !== 'idle') brain.stimulate(pick.id, 22); });
        } else {
          brain.stimulate(pick.id, 22);
        }
      }
    },
  });
  initMiniMap({ getRenderer: () => renderer });

  subscribe((reason) => {
    if (reason === 'graph-loaded') {
      buildOrUpdate();
      brain?.reloadLocal();
    } else if (reason === 'filters-changed' || reason === 'search-changed' || reason === 'focus-changed') {
      applyFilters();
    } else if (reason === 'selection-changed') { renderPanel(); refreshOverlay(); }
    else if (reason === 'hover-changed') refreshOverlay();
    else if (reason === 'config-changed') {
      reflectBrainButton();
      applyConfig();
      brainControlsApi?.syncFromState();
    } else if (reason === 'dimensions-changed') {
      reflectModeButtons();
      rebuildRenderer();
    }
  });
}

function isTyping(t) {
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}

function setupBrainAnimationPipeline() {
  if (brainAnimation) return;
  brainAnimation = createBrainAnimation();
  graphLive = createGraphLive();

  // Each delta tick: trigger a spawn animation for every freshly-arrived
  // node. Pick a parent from the existing population so the axon stream has
  // somewhere to flow from — the renderer hasn't laid out the new node yet,
  // but force-graph will give it a position by the time the stream lands.
  graphLive.subscribe((delta) => {
    const existingIds = state.graph.nodes.map((n) => n.id);
    delta.nodes.forEach((node, i) => {
      const parent = existingIds[Math.floor(Math.random() * existingIds.length)];
      setTimeout(() => brainAnimation.spawnNode(node.id, parent), i * 120);
    });
  });

  // The graph view is the only consumer for now, so start polling whenever
  // it's the active hash and stop otherwise. Same pattern as the brain
  // insights view in views/brain.js.
  const sync = () => {
    if (location.hash === '#/graph') graphLive.startPolling();
    else graphLive.stopPolling();
  };
  window.addEventListener('hashchange', sync);
  sync();

  const view = document.getElementById('view-graph') || document.body;
  ingestPanel = createIngestPanel({
    container: view,
    onIngested: () => {
      // After a successful ingest, accelerate the next poll a bit so the
      // freshly-added nodes light up without waiting a full interval.
      setTimeout(() => graphLive.startPolling(), 0);
    },
  });
  ingestPanel.show();
}

function buildOrUpdate() {
  if (state.graph.nodes.length === 0) {
    document.getElementById('stats').textContent = '0 nodes · 0 edges';
    document.getElementById('legend').classList.add('hidden');
    return;
  }
  buildTypeFilters();
  buildLegend();
  if (!renderer) rebuildRenderer();
  applyFilters();
  applyConfig();
  if (state.pendingFocus) {
    const id = state.pendingFocus;
    state.pendingFocus = null;
    setTimeout(() => focusOn(id), 250);
  }
}

function rebuildRenderer() {
  const container = document.getElementById('canvas');
  if (renderer) {
    try { brain?.stop(); } catch {}
    try { brainOverlay?.destroy(); } catch {}
    brainOverlay = null;
    try { renderer.destroy(); } catch {}
    renderer = null;
  }
  const callbacks = {
    onClick: (n) => { if (n) setSelected(n.id); },
    onRightClick: (n, evt) => { evt.preventDefault?.(); if (n) openContextMenu(n, evt); },
    onHover: (id) => setHovered(id),
    onBackgroundClick: () => { setSelected(null); closeContextMenu(); },
    onBackgroundRightClick: (evt) => { evt.preventDefault?.(); closeContextMenu(); },
  };
  if (state.config.dimensions === 3 || state.config.dimensions === 4) {
    renderer = create3DRenderer({
      container,
      callbacks,
      fourD: state.config.dimensions === 4,
    });
  }
  if (!renderer) {
    renderer = create2DRenderer({ container, callbacks });
  }
  if (renderer.kind === '2d') attachLongPress(container);
  applyFilters();
  applyConfig();
  installRegionForce();
  renderer.startSpikes?.();

  if (brainAnimation) {
    brainOverlay = createBrainOverlay({
      container,
      getRenderer: () => renderer,
      animation: brainAnimation,
    });
  }

  // (Re)wire the brain client so spikes flow into the new renderer. The
  // userId must match window.GRAPH_CONFIG.brainUserId so the gateway joins us
  // to the same room (`brain:<userId>`) the auto-started simulator emits to —
  // otherwise the socket connects but no spike events ever land here.
  if (brain) try { brain.stop(); } catch {}
  brain = createBrainClient({
    getGraph: () => state.graph,
    getUserId: () => window.GRAPH_CONFIG?.brainUserId || 'local',
    onSpike: (e) => {
      const now = performance.now();
      if (now - lastSpikeAt < 1000) spikeCount1s += 1;
      else { spikeCount1s = 1; lastSpikeAt = now; }
      renderer?.spikeNode?.(e.neuronId);
      statsBarApi?.markActive();
    },
    onWeight: () => {},
  });
  if (state.config.spikes !== false) {
    brain.start().then(() => brainControlsApi?.syncFromState());
  }
  updateModeHud();
}

function attachLongPress(container) {
  let timer = null;
  let startX = 0, startY = 0;
  let triggered = false;
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };

  container.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || !renderer || renderer.kind !== '2d') return;
    triggered = false;
    const t = e.touches[0];
    startX = t.clientX; startY = t.clientY;
    timer = setTimeout(() => {
      timer = null;
      const rect = container.getBoundingClientRect();
      const coords = renderer.screen2GraphCoords(startX - rect.left, startY - rect.top);
      const node = pickNodeAt(coords.x, coords.y);
      if (node) {
        triggered = true;
        if (navigator.vibrate) navigator.vibrate(20);
        openContextMenu(node, { clientX: startX, clientY: startY });
      }
    }, 500);
  }, { passive: true });

  container.addEventListener('touchmove', (e) => {
    if (!timer) return;
    const t = e.touches[0];
    if (Math.hypot(t.clientX - startX, t.clientY - startY) > 10) cancel();
  }, { passive: true });

  container.addEventListener('touchend', () => {
    cancel();
    if (triggered) triggered = false;
  });
  container.addEventListener('touchcancel', cancel);
}

function pickNodeAt(x, y) {
  let best = null, bestDist = Infinity;
  for (const n of state.graph.nodes) {
    if (n.x == null || n.y == null) continue;
    const r = nodeRadius(n) + 6;
    const d = Math.hypot(n.x - x, n.y - y);
    if (d <= r && d < bestDist) { best = n; bestDist = d; }
  }
  return best;
}

function nodeRadius(n) {
  const deg = n.__degree || 1;
  return Math.max(3, Math.min(20, 3 + Math.sqrt(deg) * 2));
}

function applyFilters() {
  if (!renderer) return;
  const ids = visibleNodeIds();
  const nodes = state.graph.nodes.filter((n) => ids.has(n.id));
  // Decorate with cached region so renderers can colour by it without
  // re-running the regionForNode lookup on every frame.
  for (const n of nodes) if (!n.region) n.region = regionForNode(n);
  const edges = state.graph.edges
    .filter((e) => ids.has(srcId(e)) && ids.has(tgtId(e)))
    .filter((e) => (e.weight || 0) >= state.filters.minEdgeWeight)
    .map((e) => ({ ...e, source: srcId(e), target: tgtId(e) }));
  renderer.setData({ nodes, links: edges });
  document.getElementById('stats').textContent = `${nodes.length} nodes · ${edges.length} edges`;
  document.getElementById('reset-focus').disabled = !state.focusRootId;
  const banner = document.getElementById('focus-banner');
  if (state.focusRootId) {
    banner.classList.remove('hidden');
    document.getElementById('focus-banner-label').textContent =
      truncate(state.byId.get(state.focusRootId)?.label || state.focusRootId, 50);
  } else {
    banner.classList.add('hidden');
  }
  buildLegend(ids);
  renderPanel();
}

function applyConfig() {
  if (!renderer) return;
  renderer.applyConfig();
  installRegionForce();
  if (state.config.spikes === false) {
    renderer.stopSpikes?.();
    brain?.stop();
  } else {
    if (brain && brain.mode === 'idle') {
      brain.start().then(() => brainControlsApi?.syncFromState());
    }
    renderer.startSpikes?.();
  }
}

function installRegionForce() {
  if (!renderer || !renderer.fg) return;
  const fg = renderer.fg;
  if (typeof fg.d3Force !== 'function') return;
  const k = state.config.regionClustering || 0;
  if (k <= 0) {
    if (regionForce) {
      try { fg.d3Force('region', null); } catch {}
      regionForce = null;
    }
    return;
  }
  // Build region centroid table on each tick and pull each node toward its
  // region's centroid.
  const force = function (alpha) {
    const data = fg.graphData?.();
    if (!data) return;
    const cx = new Map(), cy = new Map(), cz = new Map(), cn = new Map();
    for (const n of data.nodes) {
      const r = n.region || regionForNode(n);
      cx.set(r, (cx.get(r) || 0) + (n.x || 0));
      cy.set(r, (cy.get(r) || 0) + (n.y || 0));
      cz.set(r, (cz.get(r) || 0) + (n.z || 0));
      cn.set(r, (cn.get(r) || 0) + 1);
    }
    for (const [r, n] of cn) {
      cx.set(r, cx.get(r) / n);
      cy.set(r, cy.get(r) / n);
      cz.set(r, cz.get(r) / n);
    }
    const strength = k * alpha * 0.4;
    for (const node of data.nodes) {
      const r = node.region || regionForNode(node);
      node.vx = (node.vx || 0) + ((cx.get(r) - (node.x || 0)) * strength);
      node.vy = (node.vy || 0) + ((cy.get(r) - (node.y || 0)) * strength);
      if (node.z != null) node.vz = (node.vz || 0) + ((cz.get(r) - (node.z || 0)) * strength);
    }
  };
  fg.d3Force('region', force);
  regionForce = force;
  fg.d3ReheatSimulation?.();
}

function refreshOverlay() {
  if (!renderer) return;
  renderer.refresh?.();
}

function buildTypeFilters() {
  const types = [...new Set(state.graph.nodes.map((n) => n.type))].sort();
  const fs = document.getElementById('type-filters');
  fs.innerHTML = '';
  for (const t of types) {
    const id = `f-${t}`;
    const on = state.filters.types.has(t);
    const label = el('label', { class: on ? 'on' : '', for: id });
    label.innerHTML = `
      <input type="checkbox" id="${id}" value="${t}" ${on ? 'checked' : ''} />
      <span class="swatch" style="--c:${colorForType(t)}"></span>${t}
    `;
    label.querySelector('input').addEventListener('change', (e) => {
      toggleFilterType(t, e.target.checked);
      label.classList.toggle('on', e.target.checked);
    });
    fs.appendChild(label);
  }
}

function buildLegend(visibleIds) {
  const counts = new Map();
  const ids = visibleIds || new Set(state.graph.nodes.map((n) => n.id));
  for (const n of state.graph.nodes) {
    if (!ids.has(n.id)) continue;
    counts.set(n.type, (counts.get(n.type) || 0) + 1);
  }
  const legend = document.getElementById('legend');
  legend.innerHTML = '';
  const types = [...counts.keys()].sort();
  if (types.length === 0) { legend.classList.add('hidden'); return; }
  legend.classList.remove('hidden');
  if (state.config.colorMode === 'region') {
    const regions = new Map();
    for (const n of state.graph.nodes) {
      if (!ids.has(n.id)) continue;
      const r = n.region || regionForNode(n);
      regions.set(r, (regions.get(r) || 0) + 1);
    }
    for (const r of [...regions.keys()].sort()) {
      const row = el('div', { class: 'row' });
      row.innerHTML = `<span class="swatch" style="--c:${styleForRegion(r).color}"></span><b>${styleForRegion(r).label}</b><span class="count">${regions.get(r)}</span>`;
      legend.appendChild(row);
    }
    return;
  }
  for (const t of types) {
    const row = el('div', { class: 'row' });
    row.innerHTML = `<span class="swatch" style="--c:${colorForType(t)}"></span><b>${t}</b><span class="count">${counts.get(t)}</span>`;
    legend.appendChild(row);
  }
}

function renderPanel() {
  const panel = document.getElementById('panel');
  if (!state.selectedId) { panel.classList.remove('open'); return; }
  const node = state.byId.get(state.selectedId);
  if (!node) { panel.classList.remove('open'); return; }
  panel.classList.add('open');

  // Header — type badge + label.
  document.getElementById('panel-title').textContent = node.label || node.id;
  const badge = document.getElementById('panel-type');
  badge.textContent = node.type || 'node';
  badge.style.color = colorForType(node.type);
  badge.style.borderColor = colorForType(node.type);

  // Confidence — accept node.confidence or node.metadata.confidence,
  // fall back to a degree-derived heuristic so the bar always has something.
  const rawConf = node.confidence ?? node.metadata?.confidence;
  const conf = typeof rawConf === 'number' && Number.isFinite(rawConf)
    ? Math.max(0, Math.min(1, rawConf))
    : Math.max(0.2, Math.min(1, 0.4 + Math.log2((node.__degree || 0) + 1) * 0.12));
  const fill = document.getElementById('panel-confidence-fill');
  const num = document.getElementById('panel-confidence-num');
  // Reset width so the CSS transition replays.
  fill.style.width = '0%';
  // Force a layout reflow so the CSS width transition replays from 0
  // every time the inspector opens on a new node.
  void fill.offsetWidth;
  fill.style.width = `${(conf * 100).toFixed(1)}%`;
  num.textContent = conf.toFixed(2);

  // Source line.
  const isAuto = node.autonomous === true || (node.source || node.metadata?.source) === 'autonomous';
  document.getElementById('panel-source').textContent = isAuto ? 'autonomous' : (node.sourceId || node.source || node.metadata?.source || 'manual');

  // Created (relative).
  document.getElementById('panel-created').textContent = relTime(node.createdAt) || fmtDate(node.createdAt) || '—';

  // Connections (max 8).
  const ul = document.getElementById('panel-edges');
  ul.innerHTML = '';
  const incident = state.graph.edges.filter((e) => srcId(e) === node.id || tgtId(e) === node.id);
  document.getElementById('panel-edge-count').textContent = String(incident.length);
  const limit = Math.min(8, incident.length);
  for (let i = 0; i < limit; i++) {
    const e = incident[i];
    const otherId = srcId(e) === node.id ? tgtId(e) : srcId(e);
    const other = state.byId.get(otherId);
    if (!other) continue;
    const li = el('li');
    li.style.setProperty('--c', colorForType(other.type));
    li.innerHTML = `
      <span class="swatch"></span>
      <span class="lbl">${escape(other.label || other.id)}</span>
    `;
    li.addEventListener('click', () => {
      setSelected(other.id);
      focusOn(other.id);
    });
    ul.appendChild(li);
  }
  if (incident.length > limit) {
    const more = el('li');
    more.style.cursor = 'default';
    more.textContent = `+${incident.length - limit} more…`;
    ul.appendChild(more);
  }

  // Autonomous insight (only shown for autonomous nodes that have one).
  const insightWrap = document.getElementById('panel-insight-wrap');
  const insightText = node.cycleInsight || node.metadata?.cycleInsight || node.metadata?.insight;
  if (isAuto && insightText) {
    insightWrap.hidden = false;
    document.getElementById('panel-insight').textContent = String(insightText);
  } else {
    insightWrap.hidden = true;
  }

  // Pin button reflects pinned state.
  document.getElementById('panel-action-pin').classList.toggle('active', !!node.__pinned);

  // Raw metadata (collapsed) — preserves the older debug surface for power users.
  const meta = document.getElementById('panel-meta');
  meta.innerHTML = '';
  const region = node.region || regionForNode(node);
  const fields = [
    ['ID', node.id],
    ['Source', node.sourceId || '—'],
    ['Region', styleForRegion(region).label],
    ['Created', fmtDate(node.createdAt)],
    ['Updated', fmtDate(node.updatedAt)],
    ['Degree', String(node.__degree || 0)],
  ];
  for (const [k, v] of fields) {
    if (!v) continue;
    meta.append(el('dt', {}, k), el('dd', {}, v));
  }
  for (const [k, v] of Object.entries(node.metadata || {})) {
    if (v == null || v === '') continue;
    const dd = el('dd');
    if (typeof v === 'string' && /^https?:\/\//.test(v)) {
      const a = el('a', { href: v, target: '_blank', rel: 'noopener' }, v);
      dd.appendChild(a);
    } else if (typeof v === 'object') {
      dd.textContent = JSON.stringify(v);
    } else {
      dd.textContent = String(v);
    }
    meta.append(el('dt', {}, k), dd);
  }
}

function fourDActive() {
  return state.config.dimensions === 4;
}

function relTime(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

function focusOn(id) {
  const node = state.byId.get(id);
  if (!node || !renderer) return;
  setSelected(id);
  if (node.x != null) {
    renderer.centerOn(node, 600);
    // Ripple a BFS trace through the focused node's neighborhood so the
    // overlay shows where the user's attention just landed.
    brainAnimation?.traceQuery(id, state.graph.edges || []);
  } else {
    setTimeout(() => focusOn(id), 200);
  }
}

function clearFocus() {
  setFocusRoot(null);
}

function openContextMenu(node, evt) {
  const menu = document.getElementById('context-menu');
  menu.innerHTML = '';
  const items = [
    { label: 'Focus ego-network', fn: () => setFocusRoot(node.id) },
    { label: 'Open details', fn: () => setSelected(node.id) },
    { label: 'Stimulate neuron', fn: () => brain?.stimulate?.(node.id, 18) },
    { label: 'Copy node id', fn: () => navigator.clipboard?.writeText(node.id) },
  ];
  const url = node.sourceUrl || node.metadata?.sourceUrl;
  if (url) items.push({ label: 'Open source link', fn: () => window.open(url, '_blank', 'noopener') });
  for (const it of items) {
    const b = el('button', { type: 'button' }, it.label);
    b.addEventListener('click', () => { it.fn(); closeContextMenu(); });
    menu.appendChild(b);
  }
  menu.style.left = `${evt.clientX}px`;
  menu.style.top = `${evt.clientY}px`;
  menu.classList.remove('hidden');
}

function closeContextMenu() {
  document.getElementById('context-menu')?.classList.add('hidden');
}

function reflectModeButtons() {
  const d = state.config.dimensions;
  document.querySelectorAll('.dim-switch').forEach((sw) => {
    sw.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('active', Number(b.dataset.dim) === d);
    });
  });
}

function reflectBrainButton() {
  const btn = document.getElementById('brain-link');
  if (!btn) return;
  const on = state.config.spikes !== false;
  btn.classList.toggle('active', on);
  btn.querySelector('.lbl').textContent = on ? 'brain on' : 'brain off';
}

function startHud() {
  let frames = 0;
  let lastT = performance.now();
  function tick(t) {
    frames += 1;
    if (t - lastT >= 500) {
      const fps = Math.round((frames * 1000) / (t - lastT));
      const fpsEl = document.getElementById('hud-fps');
      if (fpsEl) fpsEl.textContent = `${fps} fps`;
      frames = 0;
      lastT = t;
      const sp = document.getElementById('hud-spikes');
      if (sp) {
        const sps = (performance.now() - lastSpikeAt < 1500) ? spikeCount1s : 0;
        sp.textContent = `${sps} spikes/s`;
      }
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function updateModeHud() {
  const m = document.getElementById('hud-mode');
  if (!m) return;
  const d = state.config.dimensions;
  m.textContent = d === 4 ? '4D' : d === 3 ? '3D' : '2D';
  const detail = document.getElementById('hud-mode-detail');
  if (detail) {
    if (d === 4) detail.textContent = `t-axis: ${state.config.temporalField}`;
    else if (d === 3) detail.textContent = 'volumetric · bloom';
    else detail.textContent = 'canvas · 2D';
  }
}

// ── Thinking fallback (insufficient-data) ──────────────────────────
//
// Shown when the cortex emits `cortex-thinking-start` but the graph has
// fewer nodes/edges than would produce a visible BFS ripple. Mounts the
// brain-preview loop in a small toast over the graph so the user still
// gets a "thinking" visualisation even when there's nothing to traverse.

const MIN_NODES_FOR_THINKING = 3;
const MIN_EDGES_FOR_THINKING = 1;
let thinkFallbackEl = null;
let thinkFallbackHandle = null;

function hasEnoughDataForThinking() {
  const nodes = state.graph?.nodes?.length || 0;
  const edges = state.graph?.edges?.length || 0;
  return nodes >= MIN_NODES_FOR_THINKING && edges >= MIN_EDGES_FOR_THINKING;
}

function showThinkFallback() {
  if (thinkFallbackEl) return; // already mounted
  const view = document.getElementById('view-graph');
  if (!view) return;
  thinkFallbackEl = document.createElement('div');
  thinkFallbackEl.className = 'brain-think-fallback';
  thinkFallbackEl.innerHTML = `
    <button type="button" class="bf-close" aria-label="Dismiss">×</button>
    <span class="bf-tag">Thinking · preview</span>
    <div class="bf-host"></div>
    <span class="bf-hint">
      Your graph is too small to traverse yet — here's what thinking will
      look like once you've ingested content.
    </span>
  `;
  view.appendChild(thinkFallbackEl);
  thinkFallbackEl.querySelector('.bf-close').addEventListener('click', hideThinkFallback);
  const host = thinkFallbackEl.querySelector('.bf-host');
  if (host) {
    try { thinkFallbackHandle = mountBrainPreview(host); } catch {}
  }
}

function hideThinkFallback() {
  if (thinkFallbackHandle) {
    try { thinkFallbackHandle.stop(); } catch {}
    thinkFallbackHandle = null;
  }
  if (thinkFallbackEl) {
    try { thinkFallbackEl.remove(); } catch {}
    thinkFallbackEl = null;
  }
}

export function focusNodeFromOutside(id) {
  if (!state.byId.has(id)) {
    state.pendingFocus = id;
    return;
  }
  setSelected(id);
  focusOn(id);
}
