import { state, subscribe, toggleFilterType } from '../state.js';
import { colorForType, escape, fmtDay, fmtTime, el } from '../util.js';
import { focusNodeFromOutside } from './graph.js';

let typeFiltersBuilt = false;
let itemCache = new Map();
let minuteTimer = null;
const MIN_CONFIDENCE = 0.2;
const BASE_CONFIDENCE = 0.4;
const DEGREE_CONFIDENCE_WEIGHT = 0.12;
const routeAbort = new AbortController();

export function initTimelineView() {
  subscribe((reason) => {
    if (reason === 'graph-loaded' || reason === 'filters-changed' || reason === 'search-changed') {
      render();
      syncMinuteTimer();
    }
  });
  window.addEventListener('hashchange', syncMinuteTimer, { signal: routeAbort.signal });
  window.addEventListener('pagehide', () => routeAbort.abort(), { once: true });
}

function syncMinuteTimer() {
  const active = location.hash === '#/timeline';
  if (active && !minuteTimer) minuteTimer = setInterval(render, 60_000);
  if (!active && minuteTimer) {
    clearInterval(minuteTimer);
    minuteTimer = null;
  }
}

function buildTypeFilters() {
  const types = [...new Set(state.graph.nodes.map((n) => n.type))].sort();
  const fs = document.getElementById('timeline-type-filters');
  fs.innerHTML = '';
  for (const t of types) {
    const id = `tf-${t}`;
    const on = state.filters.types.has(t);
    const label = el('label', { class: on ? 'on' : '', for: id });
    label.innerHTML = `
      <input type="checkbox" id="${id}" value="${t}" ${on ? 'checked' : ''} />
      <span class="swatch" style="--c:${colorForType(t)}" aria-hidden="true"></span>${escape(t)}
    `;
    label.querySelector('input').addEventListener('change', (e) => {
      toggleFilterType(t, e.target.checked);
      label.classList.toggle('on', e.target.checked);
    });
    fs.appendChild(label);
  }
  typeFiltersBuilt = true;
}

function render() {
  if (!typeFiltersBuilt) buildTypeFilters();
  const list = document.getElementById('timeline-list');

  const q = state.filters.search.trim().toLowerCase();
  const items = state.graph.nodes
    .filter((n) => state.filters.types.has(n.type))
    .filter((n) => {
      if (!q) return true;
      return (n.label || '').toLowerCase().includes(q) || (n.type || '').includes(q);
    })
    .map((n) => ({ node: n, when: n.metadata?.lastTimestamp || n.updatedAt || n.createdAt }))
    .filter((x) => x.when)
    .sort((a, b) => (a.when < b.when ? 1 : -1))
    .slice(0, 500);

  if (items.length === 0) {
    list.replaceChildren(renderEmptyTimeline());
    return;
  }

  const frag = document.createDocumentFragment();
  const liveIds = new Set();
  let lastDay = null;
  for (const { node, when } of items) {
    const day = labelDay(when);
    if (day !== lastDay) {
      frag.appendChild(el('div', { class: 'timeline-day' }, day));
      lastDay = day;
    }
    liveIds.add(node.id);
    frag.appendChild(renderItem(node, when));
  }
  for (const id of [...itemCache.keys()]) if (!liveIds.has(id)) itemCache.delete(id);
  list.replaceChildren(frag);
}

function renderEmptyTimeline() {
  const box = el('div', { class: 'empty empty-rich' });
  box.innerHTML = `
    <div class="empty-icon" aria-hidden="true">⧖</div>
    <div class="empty-copy">
      <h3>No timeline activity yet</h3>
      <p>Run an ingester to populate recent activity, then press the <kbd aria-label="press f to fit graph view">f</kbd> key on the graph to fit the view.</p>
      <p><code>npm run ingest:claude-code</code></p>
    </div>
  `;
  return box;
}

function renderItem(node, when) {
  const key = node.id;
  let item = itemCache.get(key);
  if (!item) {
    item = el('button', { class: 'timeline-item', type: 'button' });
    item.addEventListener('click', () => {
      location.hash = '#/graph';
      requestAnimationFrame(() => focusNodeFromOutside(key));
    });
    itemCache.set(key, item);
  }
  const source = node.sourceId || node.source || node.metadata?.source || 'manual';
  const conf = confidenceFor(node);
  const edges = node.__degree || 0;
  item.innerHTML = `
    <span class="timeline-time">${fmtTime(when)}</span>
    <span class="timeline-label">
      <span class="swatch" style="--c:${colorForType(node.type)}" aria-hidden="true"></span>
      <span class="sr-only">${escape(node.type)} node:</span>
      <span class="name">${escape(node.label || node.id)}</span>
    </span>
    <span class="timeline-type">${escape(node.type)}</span>
    <span class="timeline-meta">
      <span>${escape(source)}</span>
      <span class="confidence-mini" title="confidence ${Math.round(conf * 100)}%"><i style="width:${Math.round(conf * 100)}%"></i></span>
      <span>${edges} edge${edges === 1 ? '' : 's'}</span>
    </span>
  `;
  return item;
}

function confidenceFor(node) {
  const raw = node.confidence ?? node.metadata?.confidence;
  return typeof raw === 'number' && Number.isFinite(raw)
    ? Math.max(0, Math.min(1, raw))
    : Math.max(MIN_CONFIDENCE, Math.min(1, BASE_CONFIDENCE + Math.log2((node.__degree || 0) + 1) * DEGREE_CONFIDENCE_WEIGHT));
}

function labelDay(when) {
  const d = new Date(when);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  return fmtDay(when);
}
