import { state, subscribe } from '../state.js';
import { colorForType, escape, highlightSnippet, el } from '../util.js';
import { focusNodeFromOutside } from './graph.js';

export function initSearchView() {
  const input = document.getElementById('search-input');
  let debounce = null;
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
  out.innerHTML = '';
  if (!q) {
    summary.textContent = `Search across ${state.graph.nodes.length} nodes and their metadata.`;
    return;
  }
  const ql = q.toLowerCase();
  const results = [];
  for (const node of state.graph.nodes) {
    const matches = scoreNode(node, ql);
    if (matches.score > 0) results.push({ node, ...matches });
  }
  results.sort((a, b) => b.score - a.score);
  summary.textContent = `${results.length} match${results.length === 1 ? '' : 'es'} for "${q}"`;

  for (const r of results.slice(0, 200)) {
    const card = el('div', { class: 'search-result' });
    const labelHtml = highlightSnippet(r.node.label || r.node.id, q);
    const matchesHtml = r.fields
      .filter((f) => f.field !== 'label')
      .slice(0, 3)
      .map((f) => `<div><b>${escape(f.field)}:</b> ${highlightSnippet(truncateAround(f.value, ql), q)}</div>`)
      .join('');
    card.innerHTML = `
      <div>
        <div class="label"><span class="swatch" style="--c:${colorForType(r.node.type)}"></span><span>${labelHtml}</span></div>
        ${matchesHtml ? `<div class="matches">${matchesHtml}</div>` : ''}
      </div>
      <span class="type-tag">${r.node.type}</span>
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
