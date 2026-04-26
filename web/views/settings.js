import { state, subscribe, setConfig, setDimensions } from '../state.js';
import { fmtDate } from '../util.js';
import { loadGraph } from '../data.js';
import { setGraph } from '../state.js';

const PREFS_KEY = 'graph.prefs.v2';

let autoTimer = null;

const DEFAULTS = {
  dimensions: 2,
  chargeStrength: -120,
  linkDistance: 60,
  linkStrength: 0.5,
  gravity: 0.05,
  collisionRadius: 0,
  velocityDecay: 0.4,
  alphaDecay: 0.0228,
  nodeRelSize: 4,
  nodeOpacity: 1,
  edgeOpacity: 0.35,
  edgeCurvature: 0,
  edgeWidthScale: 1.6,
  showLabels: false,
  bloom: true,
  bgIntensity: 0.6,
  colorMode: 'type',
  spikes: true,
  spikeIntensity: 1,
  pulseSpeed: 1,
  linkParticles: 1,
  regionClustering: 0,
  temporalField: 'createdAt',
  temporalScale: 1,
  autoRefresh: false,
};

export function initSettingsView() {
  loadPrefs();

  // Dimensions
  document.querySelectorAll('#cfg-dim-switch button').forEach((b) => {
    b.addEventListener('click', () => setDimensions(Number(b.dataset.dim)));
  });

  // Layout physics
  bindSlider('cfg-charge', 'cfg-charge-val', (v) => setConfig({ chargeStrength: v }));
  bindSlider('cfg-link', 'cfg-link-val', (v) => setConfig({ linkDistance: v }));
  bindSlider('cfg-link-strength', 'cfg-link-strength-val', (v) => setConfig({ linkStrength: v }), 2);
  bindSlider('cfg-gravity', 'cfg-gravity-val', (v) => setConfig({ gravity: v }), 3);
  bindSlider('cfg-collision', 'cfg-collision-val', (v) => setConfig({ collisionRadius: v }));
  bindSlider('cfg-velocity', 'cfg-velocity-val', (v) => setConfig({ velocityDecay: v }), 2);
  bindSlider('cfg-region', 'cfg-region-val', (v) => {
    setConfig({ regionClustering: v });
    const t = document.getElementById('region-pull');
    const tv = document.getElementById('region-pull-val');
    if (t) t.value = String(v);
    if (tv) tv.textContent = v.toFixed(2);
  }, 2);

  // Visual style
  bindSlider('cfg-node-size', 'cfg-node-size-val', (v) => setConfig({ nodeRelSize: v }));
  bindSlider('cfg-node-opacity', 'cfg-node-opacity-val', (v) => setConfig({ nodeOpacity: v }), 2);
  bindSlider('cfg-edge-opacity', 'cfg-edge-opacity-val', (v) => setConfig({ edgeOpacity: v }), 2);
  bindSlider('cfg-edge-width', 'cfg-edge-width-val', (v) => setConfig({ edgeWidthScale: v }), 1);
  bindSlider('cfg-edge-curve', 'cfg-edge-curve-val', (v) => setConfig({ edgeCurvature: v }), 2);
  document.getElementById('cfg-colormode').addEventListener('change', (e) => {
    setConfig({ colorMode: e.target.value });
    savePrefs();
  });

  // Neural link
  document.getElementById('cfg-spikes').addEventListener('change', (e) => {
    setConfig({ spikes: e.target.checked });
    savePrefs();
  });
  bindSlider('cfg-spike-int', 'cfg-spike-int-val', (v) => setConfig({ spikeIntensity: v }), 1);
  bindSlider('cfg-pulse-speed', 'cfg-pulse-speed-val', (v) => setConfig({ pulseSpeed: v }), 2);
  bindSlider('cfg-particles', 'cfg-particles-val', (v) => setConfig({ linkParticles: v }));

  // 4D temporal
  bindSlider('cfg-tscale', 'cfg-tscale-val', (v) => setConfig({ temporalScale: v }), 1);
  document.getElementById('cfg-tfield').addEventListener('change', (e) => {
    setConfig({ temporalField: e.target.value });
    savePrefs();
  });
  document.getElementById('cfg-bloom').addEventListener('change', (e) => {
    setConfig({ bloom: e.target.checked });
    savePrefs();
  });

  // Display
  document.getElementById('cfg-labels').addEventListener('change', (e) => {
    setConfig({ showLabels: e.target.checked });
    savePrefs();
  });
  document.getElementById('cfg-auto-refresh').addEventListener('change', (e) => {
    setConfig({ autoRefresh: e.target.checked });
    savePrefs();
    updateAutoRefresh();
  });

  document.getElementById('cfg-reset').addEventListener('click', () => {
    Object.assign(state.config, structuredClone(DEFAULTS));
    setConfig({});
    setDimensions(DEFAULTS.dimensions);
    reflectAllInUI();
    savePrefs();
  });

  document.getElementById('cfg-reload').addEventListener('click', async () => {
    const fresh = await loadGraph();
    setGraph(fresh);
  });

  subscribe((reason) => {
    if (reason === 'graph-loaded') {
      const u = state.graph.metadata?.updatedAt;
      document.getElementById('cfg-updated').textContent = u ? fmtDate(u) : '—';
    } else if (reason === 'dimensions-changed' || reason === 'config-changed') {
      reflectDimSwitch();
    }
  });

  reflectAllInUI();
  updateAutoRefresh();
}

function bindSlider(id, valId, onChange, decimals = 0) {
  const input = document.getElementById(id);
  const out = document.getElementById(valId);
  const fmt = (v) => decimals > 0 ? Number(v).toFixed(decimals) : String(v);
  out.textContent = fmt(input.value);
  input.addEventListener('input', () => {
    out.textContent = fmt(input.value);
    onChange(Number(input.value));
    savePrefs();
  });
}

function setVal(id, v, outId, decimals = 0) {
  const input = document.getElementById(id);
  if (!input) return;
  input.value = String(v);
  const out = document.getElementById(outId);
  if (out) out.textContent = decimals > 0 ? Number(v).toFixed(decimals) : String(v);
}

function reflectAllInUI() {
  const c = state.config;
  setVal('cfg-charge', c.chargeStrength, 'cfg-charge-val');
  setVal('cfg-link', c.linkDistance, 'cfg-link-val');
  setVal('cfg-link-strength', c.linkStrength, 'cfg-link-strength-val', 2);
  setVal('cfg-gravity', c.gravity, 'cfg-gravity-val', 3);
  setVal('cfg-collision', c.collisionRadius, 'cfg-collision-val');
  setVal('cfg-velocity', c.velocityDecay, 'cfg-velocity-val', 2);
  setVal('cfg-region', c.regionClustering, 'cfg-region-val', 2);
  setVal('cfg-node-size', c.nodeRelSize, 'cfg-node-size-val');
  setVal('cfg-node-opacity', c.nodeOpacity, 'cfg-node-opacity-val', 2);
  setVal('cfg-edge-opacity', c.edgeOpacity, 'cfg-edge-opacity-val', 2);
  setVal('cfg-edge-width', c.edgeWidthScale, 'cfg-edge-width-val', 1);
  setVal('cfg-edge-curve', c.edgeCurvature, 'cfg-edge-curve-val', 2);
  setVal('cfg-spike-int', c.spikeIntensity, 'cfg-spike-int-val', 1);
  setVal('cfg-pulse-speed', c.pulseSpeed, 'cfg-pulse-speed-val', 2);
  setVal('cfg-particles', c.linkParticles, 'cfg-particles-val');
  setVal('cfg-tscale', c.temporalScale, 'cfg-tscale-val', 1);
  const colorEl = document.getElementById('cfg-colormode');
  if (colorEl) colorEl.value = c.colorMode || 'type';
  const tField = document.getElementById('cfg-tfield');
  if (tField) tField.value = c.temporalField || 'createdAt';
  const labels = document.getElementById('cfg-labels');
  if (labels) labels.checked = !!c.showLabels;
  const spikes = document.getElementById('cfg-spikes');
  if (spikes) spikes.checked = c.spikes !== false;
  const autoR = document.getElementById('cfg-auto-refresh');
  if (autoR) autoR.checked = !!c.autoRefresh;
  const bloom = document.getElementById('cfg-bloom');
  if (bloom) bloom.checked = c.bloom !== false;
  reflectDimSwitch();
  // Region pull twin slider in toolbar
  const rp = document.getElementById('region-pull');
  const rpv = document.getElementById('region-pull-val');
  if (rp) rp.value = String(c.regionClustering ?? 0);
  if (rpv) rpv.textContent = (c.regionClustering ?? 0).toFixed(2);
}

function reflectDimSwitch() {
  const d = state.config.dimensions;
  document.querySelectorAll('#cfg-dim-switch button').forEach((b) => {
    b.classList.toggle('active', Number(b.dataset.dim) === d);
  });
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
