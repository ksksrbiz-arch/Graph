const TYPE_COLOR = {
  project: getCss('--t-project'),
  conversation: getCss('--t-conversation'),
  tool: getCss('--t-tool'),
  file: getCss('--t-file'),
  model: getCss('--t-model'),
  concept: getCss('--t-concept'),
};
const DEFAULT_COLOR = getCss('--t-default');

function getCss(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#999';
}

const state = {
  data: { nodes: [], edges: [] },
  filteredTypes: new Set(),
  search: '',
  selectedId: null,
  graph: null,
};

const $ = (sel) => document.querySelector(sel);

async function loadGraph() {
  const res = await fetch(`./data/graph.json?ts=${Date.now()}`);
  if (!res.ok) throw new Error(`Failed to load graph.json (${res.status})`);
  return await res.json();
}

function buildTypeFilters(nodes) {
  const types = [...new Set(nodes.map((n) => n.type))].sort();
  state.filteredTypes = new Set(types);
  const fieldset = $('#type-filters');
  fieldset.innerHTML = '';
  for (const t of types) {
    const id = `f-${t}`;
    const label = document.createElement('label');
    label.className = 'on';
    label.htmlFor = id;
    const color = TYPE_COLOR[t] || DEFAULT_COLOR;
    label.innerHTML = `
      <input type="checkbox" id="${id}" value="${t}" checked />
      <span class="swatch" style="--c:${color}"></span>${t}
    `;
    label.querySelector('input').addEventListener('change', (e) => {
      if (e.target.checked) state.filteredTypes.add(t);
      else state.filteredTypes.delete(t);
      label.classList.toggle('on', e.target.checked);
      applyFilters();
    });
    fieldset.appendChild(label);
  }
}

function applyFilters() {
  const q = state.search.toLowerCase();
  const nodeIds = new Set(
    state.data.nodes
      .filter((n) => state.filteredTypes.has(n.type))
      .filter((n) => !q || (n.label || '').toLowerCase().includes(q))
      .map((n) => n.id),
  );
  const nodes = state.data.nodes.filter((n) => nodeIds.has(n.id));
  const edges = state.data.edges.filter((e) => nodeIds.has(srcId(e)) && nodeIds.has(tgtId(e)));
  $('#stats').textContent = `${nodes.length} nodes · ${edges.length} edges`;
  state.graph.graphData({ nodes, links: edges.map((e) => ({ ...e, source: srcId(e), target: tgtId(e) })) });
}

function srcId(e) { return typeof e.source === 'object' ? e.source.id : e.source; }
function tgtId(e) { return typeof e.target === 'object' ? e.target.id : e.target; }

function nodeColor(node) { return TYPE_COLOR[node.type] || DEFAULT_COLOR; }
function nodeRadius(node) {
  const deg = node.__degree || 1;
  return Math.max(3, Math.min(18, 3 + Math.sqrt(deg) * 2));
}

function computeDegrees(nodes, edges) {
  const deg = new Map();
  for (const e of edges) {
    deg.set(srcId(e), (deg.get(srcId(e)) || 0) + 1);
    deg.set(tgtId(e), (deg.get(tgtId(e)) || 0) + 1);
  }
  for (const n of nodes) n.__degree = deg.get(n.id) || 0;
}

function renderEmpty(message, hint) {
  $('#canvas').innerHTML = `
    <div class="empty">
      <div>${message}</div>
      ${hint ? `<div>${hint}</div>` : ''}
    </div>`;
}

function showPanel(node) {
  state.selectedId = node.id;
  $('#panel').classList.remove('hidden');
  $('#panel-title').textContent = node.label || node.id;
  $('#panel-type').textContent = node.type;

  const meta = $('#panel-meta');
  meta.innerHTML = '';
  const fields = [
    ['ID', node.id],
    ['Source', node.sourceId || '—'],
    ['Created', fmtDate(node.createdAt)],
    ['Updated', fmtDate(node.updatedAt)],
  ];
  for (const [k, v] of fields) {
    if (!v) continue;
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    meta.append(dt, dd);
  }
  for (const [k, v] of Object.entries(node.metadata || {})) {
    if (v == null || v === '') continue;
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd');
    if (typeof v === 'string' && /^https?:\/\//.test(v)) {
      const a = document.createElement('a'); a.href = v; a.target = '_blank'; a.rel = 'noopener';
      a.textContent = v; dd.appendChild(a);
    } else {
      dd.textContent = typeof v === 'object' ? JSON.stringify(v) : String(v);
    }
    meta.append(dt, dd);
  }

  const ul = $('#panel-edges');
  ul.innerHTML = '';
  const incident = state.data.edges.filter((e) => srcId(e) === node.id || tgtId(e) === node.id);
  const byId = new Map(state.data.nodes.map((n) => [n.id, n]));
  for (const e of incident) {
    const otherId = srcId(e) === node.id ? tgtId(e) : srcId(e);
    const other = byId.get(otherId);
    if (!other) continue;
    const li = document.createElement('li');
    li.innerHTML = `<span>${escape(other.label || other.id)}</span><span class="rel">${e.relation}</span>`;
    li.addEventListener('click', () => focusNode(other));
    ul.appendChild(li);
  }
}

function focusNode(node) {
  showPanel(node);
  if (node.x != null && node.y != null) {
    state.graph.centerAt(node.x, node.y, 600);
    state.graph.zoom(3, 600);
  }
}

function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString();
}

function escape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function initGraph(container) {
  const fg = ForceGraph()(container)
    .backgroundColor('rgba(0,0,0,0)')
    .nodeId('id')
    .nodeLabel((n) => `${escape(n.label || n.id)} — ${n.type}`)
    .nodeColor(nodeColor)
    .nodeVal((n) => Math.max(1, n.__degree || 1))
    .nodeRelSize(4)
    .linkColor(() => 'rgba(160,170,190,0.25)')
    .linkWidth((l) => 0.5 + (l.weight || 0.3) * 1.4)
    .linkDirectionalParticles(0)
    .onNodeClick((n) => focusNode(n))
    .onNodeHover((n) => { container.style.cursor = n ? 'pointer' : 'default'; })
    .nodeCanvasObjectMode(() => 'after')
    .nodeCanvasObject((node, ctx, scale) => {
      if (scale < 1.4 && (node.__degree || 0) < 4) return;
      const label = node.label || node.id;
      const fontSize = Math.max(9, 12 / scale);
      ctx.font = `${fontSize}px -apple-system, system-ui, sans-serif`;
      ctx.fillStyle = '#e6e8ee';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const r = nodeRadius(node);
      ctx.fillText(truncate(label, 40), node.x + r + 3, node.y);
    });

  const ro = new ResizeObserver(() => {
    fg.width(container.clientWidth).height(container.clientHeight);
  });
  ro.observe(container);
  fg.width(container.clientWidth).height(container.clientHeight);
  return fg;
}

function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

async function bootstrap() {
  let data;
  try {
    data = await loadGraph();
  } catch (err) {
    renderEmpty(
      'No graph data yet.',
      'Run <code>npm run ingest:claude-code</code> to populate <code>data/graph.json</code>.',
    );
    $('#stats').textContent = '0 nodes · 0 edges';
    return;
  }

  if (!data.nodes || data.nodes.length === 0) {
    renderEmpty(
      'Graph is empty.',
      'Run <code>npm run ingest:claude-code</code> to add your Claude conversations.',
    );
    $('#stats').textContent = '0 nodes · 0 edges';
    return;
  }

  state.data = data;
  computeDegrees(data.nodes, data.edges);
  buildTypeFilters(data.nodes);
  state.graph = initGraph($('#canvas'));
  applyFilters();

  if (data.metadata?.updatedAt) {
    $('#last-updated').textContent = `updated ${fmtDate(data.metadata.updatedAt)}`;
  }
}

$('#search').addEventListener('input', (e) => {
  state.search = e.target.value;
  if (state.graph) applyFilters();
});

$('#reload').addEventListener('click', () => bootstrap());
$('#panel-close').addEventListener('click', () => $('#panel').classList.add('hidden'));

bootstrap();
