import {
  state, subscribe, emit, setSelected, setFocusRoot, setHovered,
  setMinEdgeWeight, toggleFilterType, visibleNodeIds,
} from '../state.js';
import { colorForType, escape, fmtDate, srcId, tgtId, truncate, el } from '../util.js';

let fg = null;

export function initGraphView() {
  const canvas = document.getElementById('canvas');

  document.getElementById('fit-btn').addEventListener('click', () => fg?.zoomToFit(500, 60));
  document.getElementById('zoom-in').addEventListener('click', () => fg && fg.zoom(fg.zoom() * 1.4, 250));
  document.getElementById('zoom-out').addEventListener('click', () => fg && fg.zoom(fg.zoom() / 1.4, 250));
  document.getElementById('reset-focus').addEventListener('click', clearFocus);
  document.getElementById('focus-banner-close').addEventListener('click', clearFocus);

  const weightSlider = document.getElementById('edge-weight');
  weightSlider.addEventListener('input', () => {
    document.getElementById('edge-weight-val').textContent = Number(weightSlider.value).toFixed(2);
    setMinEdgeWeight(Number(weightSlider.value));
  });

  document.getElementById('panel-close').addEventListener('click', () => setSelected(null));
  document.getElementById('panel-focus').addEventListener('click', () => {
    if (state.selectedId) setFocusRoot(state.selectedId);
  });
  document.getElementById('panel-open').addEventListener('click', () => {
    const n = state.byId.get(state.selectedId);
    const url = n?.metadata?.sourceUrl || n?.sourceUrl || n?.metadata?.url;
    if (url) window.open(url, '_blank', 'noopener');
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
      fg?.zoomToFit(500, 60);
    }
  });

  subscribe((reason) => {
    if (reason === 'graph-loaded') buildOrUpdate();
    else if (reason === 'filters-changed' || reason === 'search-changed' || reason === 'focus-changed') applyFilters();
    else if (reason === 'selection-changed') { renderPanel(); refreshOverlay(); }
    else if (reason === 'hover-changed') refreshOverlay();
    else if (reason === 'config-changed') applyConfig();
  });
}

function isTyping(t) {
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}

function buildOrUpdate() {
  if (state.graph.nodes.length === 0) {
    document.getElementById('stats').textContent = '0 nodes · 0 edges';
    document.getElementById('legend').classList.add('hidden');
    return;
  }
  buildTypeFilters();
  buildLegend();
  if (!fg) initForceGraph();
  applyFilters();
  applyConfig();
  if (state.pendingFocus) {
    const id = state.pendingFocus;
    state.pendingFocus = null;
    setTimeout(() => focusOn(id), 250);
  }
}

function initForceGraph() {
  const container = document.getElementById('canvas');
  container.innerHTML = '';
  fg = ForceGraph()(container)
    .backgroundColor('rgba(0,0,0,0)')
    .nodeId('id')
    .nodeLabel((n) => `${escape(n.label || n.id)} — ${n.type}`)
    .nodeVal((n) => Math.max(1, Math.sqrt(n.__degree || 1) * 3))
    .nodeRelSize(4)
    .linkColor((l) => edgeColor(l))
    .linkWidth((l) => 0.4 + (l.weight || 0.3) * 1.6)
    .linkDirectionalParticles(() => state.config.particles ? 2 : 0)
    .linkDirectionalParticleWidth(2)
    .linkDirectionalParticleSpeed(() => 0.005)
    .onNodeHover((n) => {
      document.getElementById('canvas').style.cursor = n ? 'pointer' : 'default';
      setHovered(n ? n.id : null);
    })
    .onNodeClick((n) => { setSelected(n.id); })
    .onNodeRightClick((n, evt) => { evt.preventDefault(); openContextMenu(n, evt); })
    .onBackgroundClick(() => { setSelected(null); closeContextMenu(); })
    .onBackgroundRightClick((evt) => { evt.preventDefault(); closeContextMenu(); })
    .nodeCanvasObjectMode((n) => 'after')
    .nodeCanvasObject(drawNode);

  const ro = new ResizeObserver(() => {
    fg.width(container.clientWidth).height(container.clientHeight);
  });
  ro.observe(container);
  fg.width(container.clientWidth).height(container.clientHeight);

  attachLongPress(container);
}

function attachLongPress(container) {
  let timer = null;
  let startX = 0, startY = 0;
  let triggered = false;
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };

  container.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || !fg) return;
    triggered = false;
    const t = e.touches[0];
    startX = t.clientX; startY = t.clientY;
    timer = setTimeout(() => {
      timer = null;
      const rect = container.getBoundingClientRect();
      const coords = fg.screen2GraphCoords(startX - rect.left, startY - rect.top);
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

function drawNode(node, ctx, scale) {
  const r = nodeRadius(node);
  const dim = isDimmed(node);
  const c = colorForType(node.type);
  ctx.beginPath();
  ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
  ctx.fillStyle = dim ? withAlpha(c, 0.18) : c;
  ctx.fill();
  if (state.selectedId === node.id || state.focusRootId === node.id) {
    ctx.lineWidth = 2 / scale;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
  } else if (state.hoveredId === node.id) {
    ctx.lineWidth = 1.5 / scale;
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.stroke();
  }
  const isFocal =
    node.id === state.selectedId ||
    node.id === state.hoveredId ||
    node.id === state.focusRootId;
  const focalAnchor = state.hoveredId || state.selectedId;
  const isFocalNeighbor = focalAnchor && focalAnchor !== node.id &&
    state.adjacency.get(focalAnchor)?.has(node.id);

  let drawLabel = false;
  if (isFocal || isFocalNeighbor) {
    drawLabel = true;
  } else if (state.config.showLabels) {
    const isHub = (node.__degree || 0) >= 4;
    if (isHub || scale >= 1.5) drawLabel = true;
  }
  if (!drawLabel) return;

  const label = node.label || node.id;
  const fontSize = Math.max(10, 12 / scale);
  ctx.font = `${fontSize}px -apple-system, system-ui, sans-serif`;
  const textX = node.x + r + 4;
  const textY = node.y;
  if (isFocal) {
    ctx.font = `600 ${fontSize}px -apple-system, system-ui, sans-serif`;
    const text = truncate(label, 40);
    const padX = 4 / scale;
    const padY = 2 / scale;
    const w = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(11,13,18,0.78)';
    ctx.fillRect(textX - padX, textY - fontSize / 2 - padY, w + padX * 2, fontSize + padY * 2);
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, textX, textY);
  } else {
    ctx.fillStyle = dim ? 'rgba(230,232,238,0.35)' : '#e6e8ee';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(truncate(label, 40), textX, textY);
  }
}

function nodeRadius(n) {
  const deg = n.__degree || 1;
  return Math.max(3, Math.min(20, 3 + Math.sqrt(deg) * 2));
}

function isDimmed(node) {
  if (!state.hoveredId) return false;
  if (state.hoveredId === node.id) return false;
  const nbrs = state.adjacency.get(state.hoveredId);
  return !(nbrs && nbrs.has(node.id));
}

function edgeColor(link) {
  if (state.hoveredId) {
    const s = srcId(link), t = tgtId(link);
    if (s === state.hoveredId || t === state.hoveredId) return 'rgba(124,156,255,0.85)';
    return 'rgba(160,170,190,0.08)';
  }
  return 'rgba(160,170,190,0.22)';
}

function withAlpha(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function applyFilters() {
  if (!fg) return;
  const ids = visibleNodeIds();
  const nodes = state.graph.nodes.filter((n) => ids.has(n.id));
  const edges = state.graph.edges
    .filter((e) => ids.has(srcId(e)) && ids.has(tgtId(e)))
    .filter((e) => (e.weight || 0) >= state.filters.minEdgeWeight)
    .map((e) => ({ ...e, source: srcId(e), target: tgtId(e) }));
  fg.graphData({ nodes, links: edges });
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
  if (!fg) return;
  const charge = fg.d3Force('charge');
  if (charge) charge.strength(state.config.chargeStrength);
  const link = fg.d3Force('link');
  if (link) link.distance(state.config.linkDistance);
  fg.nodeRelSize(state.config.nodeRelSize);
  fg.linkDirectionalParticles(() => state.config.particles ? 2 : 0);
  fg.d3ReheatSimulation();
  fg.refresh();
}

function refreshOverlay() {
  if (fg) fg.refresh();
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
  for (const t of types) {
    const row = el('div', { class: 'row' });
    row.innerHTML = `<span class="swatch" style="--c:${colorForType(t)}"></span><b>${t}</b><span class="count">${counts.get(t)}</span>`;
    legend.appendChild(row);
  }
}

function renderPanel() {
  const panel = document.getElementById('panel');
  if (!state.selectedId) { panel.classList.add('hidden'); return; }
  const node = state.byId.get(state.selectedId);
  if (!node) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  document.getElementById('panel-title').textContent = node.label || node.id;
  document.getElementById('panel-type').textContent = node.type;

  const url = node.sourceUrl || node.metadata?.sourceUrl || node.metadata?.url;
  document.getElementById('panel-open').disabled = !url;

  const meta = document.getElementById('panel-meta');
  meta.innerHTML = '';
  const fields = [
    ['ID', node.id],
    ['Source', node.sourceId || '—'],
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

  const ul = document.getElementById('panel-edges');
  ul.innerHTML = '';
  const incident = state.graph.edges.filter((e) => srcId(e) === node.id || tgtId(e) === node.id);
  document.getElementById('panel-edge-count').textContent = String(incident.length);
  for (const e of incident) {
    const otherId = srcId(e) === node.id ? tgtId(e) : srcId(e);
    const other = state.byId.get(otherId);
    if (!other) continue;
    const li = el('li');
    li.innerHTML = `
      <span class="lbl"><span class="swatch" style="--c:${colorForType(other.type)}"></span><span>${escape(other.label || other.id)}</span></span>
      <span class="rel">${e.relation}</span>
    `;
    li.addEventListener('click', () => {
      setSelected(other.id);
      focusOn(other.id);
    });
    ul.appendChild(li);
  }
}

function focusOn(id) {
  const node = state.byId.get(id);
  if (!node || !fg) return;
  setSelected(id);
  if (node.x != null && node.y != null) {
    fg.centerAt(node.x, node.y, 600);
    fg.zoom(Math.max(fg.zoom(), 2.5), 600);
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

export function focusNodeFromOutside(id) {
  if (!state.byId.has(id)) {
    state.pendingFocus = id;
    return;
  }
  setSelected(id);
  focusOn(id);
}
