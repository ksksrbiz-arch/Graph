import { state, subscribe, setConfig } from '../state.js';
import { fmtDate } from '../util.js';
import { loadGraph } from '../data.js';
import { setGraph } from '../state.js';

const PREFS_KEY = 'graph.prefs.v1';

let autoTimer = null;

export function initSettingsView() {
  loadPrefs();

  bindSlider('cfg-charge', 'cfg-charge-val', (v) => setConfig({ chargeStrength: v }));
  bindSlider('cfg-link', 'cfg-link-val', (v) => setConfig({ linkDistance: v }));
  bindSlider('cfg-node-size', 'cfg-node-size-val', (v) => setConfig({ nodeRelSize: v }));

  document.getElementById('cfg-labels').addEventListener('change', (e) => {
    setConfig({ showLabels: e.target.checked });
    savePrefs();
  });
  document.getElementById('cfg-spikes').addEventListener('change', (e) => {
    setConfig({ spikes: e.target.checked });
    savePrefs();
  });
  document.getElementById('cfg-auto-refresh').addEventListener('change', (e) => {
    setConfig({ autoRefresh: e.target.checked });
    savePrefs();
    updateAutoRefresh();
  });

  document.getElementById('cfg-reload').addEventListener('click', async () => {
    const fresh = await loadGraph();
    setGraph(fresh);
  });

  subscribe((reason) => {
    if (reason === 'graph-loaded') {
      const u = state.graph.metadata?.updatedAt;
      document.getElementById('cfg-updated').textContent = u ? fmtDate(u) : '—';
    }
  });

  reflectConfigInUI();
  updateAutoRefresh();
}

function bindSlider(id, valId, onChange) {
  const input = document.getElementById(id);
  const out = document.getElementById(valId);
  out.textContent = input.value;
  input.addEventListener('input', () => {
    out.textContent = input.value;
    onChange(Number(input.value));
    savePrefs();
  });
}

function reflectConfigInUI() {
  const c = state.config;
  setVal('cfg-charge', c.chargeStrength, 'cfg-charge-val');
  setVal('cfg-link', c.linkDistance, 'cfg-link-val');
  setVal('cfg-node-size', c.nodeRelSize, 'cfg-node-size-val');
  document.getElementById('cfg-labels').checked = c.showLabels;
  document.getElementById('cfg-spikes').checked = c.spikes !== false;
  document.getElementById('cfg-auto-refresh').checked = c.autoRefresh;
}

function setVal(id, v, outId) {
  const input = document.getElementById(id);
  input.value = String(v);
  document.getElementById(outId).textContent = String(v);
}

function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    Object.assign(state.config, saved);
  } catch {}
}

function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(state.config)); } catch {}
}

function updateAutoRefresh() {
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
  if (state.config.autoRefresh) {
    autoTimer = setInterval(async () => {
      try {
        const fresh = await loadGraph();
        if (fresh.metadata?.updatedAt !== state.graph.metadata?.updatedAt) {
          setGraph(fresh);
        }
      } catch {}
    }, 30000);
  }
}
