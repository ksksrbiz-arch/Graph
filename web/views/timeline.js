import { state, subscribe, toggleFilterType } from '../state.js';
import { colorForType, escape, fmtDay, fmtTime, el } from '../util.js';
import { focusNodeFromOutside } from './graph.js';

let typeFiltersBuilt = false;

export function initTimelineView() {
  subscribe((reason) => {
    if (reason === 'graph-loaded' || reason === 'filters-changed' || reason === 'search-changed') {
      render();
    }
  });
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
      <span class="swatch" style="--c:${colorForType(t)}"></span>${t}
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
  list.innerHTML = '';

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
    list.appendChild(el('div', { class: 'empty' }, 'No nodes to show yet.'));
    return;
  }

  let lastDay = null;
  for (const { node, when } of items) {
    const day = fmtDay(when);
    if (day !== lastDay) {
      list.appendChild(el('div', { class: 'timeline-day' }, day));
      lastDay = day;
    }
    const item = el('div', { class: 'timeline-item' });
    item.innerHTML = `
      <span class="timeline-time">${fmtTime(when)}</span>
      <span class="timeline-label">
        <span class="swatch" style="--c:${colorForType(node.type)}"></span>
        <span class="name">${escape(node.label || node.id)}</span>
      </span>
      <span class="timeline-type">${node.type}</span>
    `;
    item.addEventListener('click', () => {
      location.hash = '#/graph';
      requestAnimationFrame(() => focusNodeFromOutside(node.id));
    });
    list.appendChild(item);
  }
}
