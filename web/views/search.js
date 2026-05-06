import { state, subscribe } from '../state.js';
import { colorForType, escape, highlightSnippet, el } from '../util.js';
import { focusNodeFromOutside } from './graph.js';

let worker = null;
let lastQuery = '';

export function initSearchView() {
  const input = document.getElementById('search-input');
  let debounce = null;
  try {
    worker = new Worker(new URL('../search-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (event) => {
      if (event.data?.query !== lastQuery) return;
      renderResults(event.data.results || [], lastQuery);
    };
  } catch (err) {
    console.warn('[search] worker unavailable, using main thread search', err);
  }
  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(render, 100);
  });
  subscribe((reason) => {
    if (reason === 'graph-loaded') render();
  });
}

function render() {
  const input = document.getElementById('search-input');
  const out = document.getElementById('search-results');
  const summary = document.getElementById('search-summary');
  const q = input.value.trim();
  lastQuery = q;
  out.innerHTML = '';
  if (!q) {
    renderDiscovery(out, summary);
    return;
  }
  summary.textContent = `Searching ${state.graph.nodes.length} nodes for "${q}"…`;
  if (worker) {
    worker.postMessage({ query: q, nodes: state.graph.nodes });
  } else {
    const ql = q.toLowerCase();
    const results = [];
    for (const node of state.graph.nodes) {
      const matches = scoreNode(node, ql);
      if (matches.score > 0) results.push({ node, ...matches });
    }
    results.sort((a, b) => b.score - a.score);
    renderResults(results.slice(0, 200), q);
  }
}

function renderDiscovery(out, summary) {
  summary.textContent = `Search across ${state.graph.nodes.length} nodes and their metadata.`;
  const recent = [...state.graph.nodes]
    .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))
    .slice(0, 8);
  if (recent.length === 0) {
    out.appendChild(el('div', { class: 'empty empty-rich' }, 'No nodes are indexed yet. Run an ingester to unlock search.'));
    return;
  }
  const types = [...new Set(state.graph.nodes.map((n) => n.type))].slice(0, 10);
  const box = el('div', { class: 'search-discovery' });
  box.innerHTML = `
    <section>
      <h3>Recent nodes</h3>
      <div class="search-chip-list">${recent.map((n) => `<button type="button" data-node="${escape(n.id)}"><span class="swatch" style="--c:${colorForType(n.type)}" aria-hidden="true"></span>${escape(n.label || n.id)}</button>`).join('')}</div>
    </section>
    <section>
      <h3>Popular types</h3>
      <div class="search-chip-list">${types.map((t) => `<button type="button" data-query="${escape(t)}"><span class="swatch" style="--c:${colorForType(t)}" aria-hidden="true"></span>${escape(t)}</button>`).join('')}</div>
    </section>
  `;
  box.querySelectorAll('[data-node]').forEach((btn) => btn.addEventListener('click', () => {
    location.hash = '#/graph';
    requestAnimationFrame(() => focusNodeFromOutside(btn.dataset.node));
  }));
  box.querySelectorAll('[data-query]').forEach((btn) => btn.addEventListener('click', () => {
    document.getElementById('search-input').value = btn.dataset.query;
    render();
  }));
  out.appendChild(box);
}

function renderResults(results, q) {
  const out = document.getElementById('search-results');
  const summary = document.getElementById('search-summary');
  out.innerHTML = '';
  summary.textContent = `${results.length} match${results.length === 1 ? '' : 'es'} for "${q}"`;
  if (results.length === 0) {
    out.appendChild(el('div', { class: 'empty empty-rich' }, 'No matching labels or metadata. Try a broader term.'));
    return;
  }
  for (const r of results) {
    const card = el('button', { class: 'search-result', type: 'button' });
    const labelHtml = highlightSnippet(r.node.label || r.node.id, q);
    const matchesHtml = r.fields
      .filter((f) => f.field !== 'label')
      .slice(0, 3)
      .map((f) => `<div><b>${escape(f.field)}:</b> ${highlightSnippet(truncateAround(f.value, q.toLowerCase()), q)}</div>`)
      .join('');
    card.innerHTML = `
      <div>
        <div class="label"><span class="swatch" style="--c:${colorForType(r.node.type)}" aria-hidden="true"></span><span class="sr-only">${escape(r.node.type)} node:</span><span>${labelHtml}</span></div>
        ${matchesHtml ? `<div class="matches">${matchesHtml}</div>` : ''}
      </div>
      <span class="type-tag">${escape(r.node.type)}</span>
    `;
    card.addEventListener('click', () => {
      location.hash = '#/graph';
      requestAnimationFrame(() => focusNodeFromOutside(r.node.id));
    });
    out.appendChild(card);
  }
}

function scoreNode(node, ql) {
  const fields = [];
  let score = 0;
  const push = (field, value, weight) => {
    if (value == null) return;
    const s = String(value);
    if (s.toLowerCase().includes(ql)) {
      fields.push({ field, value: s });
      score += weight;
    }
  };
  push('label', node.label, 5);
  push('type', node.type, 1);
  push('id', node.id, 0.5);
  for (const [k, v] of Object.entries(node.metadata || {})) {
    if (typeof v === 'object') continue;
    push(k, v, 1);
  }
  return { score, fields };
}

function truncateAround(value, ql) {
  const s = String(value);
  const idx = s.toLowerCase().indexOf(ql);
  if (idx < 0) return s.length > 120 ? s.slice(0, 119) + '…' : s;
  const start = Math.max(0, idx - 30);
  const end = Math.min(s.length, idx + ql.length + 60);
  return (start > 0 ? '…' : '') + s.slice(start, end) + (end < s.length ? '…' : '');
}
