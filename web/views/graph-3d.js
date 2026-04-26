// 3D / 4D renderer. Uses 3d-force-graph (Three.js + d3-force-3d) for full
// volumetric rendering. The 4D mode is 3D + a temporal axis: each node's
// Z-coordinate is pinned to a normalised function of its createdAt/updatedAt
// timestamp, producing a "tree of time" that you can orbit through.
//
// Spike events from the brain client trigger one-shot directional particles
// along outgoing edges plus a brief emissive pulse on the firing neuron.

import { state } from '../state.js';
import { colorForType, srcId, tgtId } from '../util.js';
import { regionForNode, styleForRegion } from '../cortex.js';

const PULSE_DURATION_MS = 700;

export function create3DRenderer({ container, callbacks, fourD = false }) {
  container.innerHTML = '';
  if (typeof window.ForceGraph3D !== 'function') {
    container.innerHTML = `<div class="empty"><div>3D renderer failed to load (vendor/3d-force-graph.min.js).</div></div>`;
    return null;
  }

  const fg = window.ForceGraph3D({
    controlType: 'orbit',
    rendererConfig: { antialias: true, alpha: true },
  })(container)
    .backgroundColor('rgba(8,10,16,1)')
    .showNavInfo(false)
    .nodeId('id')
    .nodeLabel((n) => `${escapeLabel(n.label || n.id)} — ${n.type}`)
    .nodeRelSize(state.config.nodeRelSize)
    .nodeVal((n) => Math.max(1, Math.sqrt(n.__degree || 1) * 3))
    .nodeColor((n) => nodeColor(n))
    .nodeOpacity(state.config.nodeOpacity ?? 0.95)
    .nodeResolution(16)
    .linkColor((l) => edgeColor(l))
    .linkOpacity(state.config.edgeOpacity ?? 0.35)
    .linkWidth((l) => 0.2 + (l.weight || 0.3) * (state.config.edgeWidthScale ?? 1.6) * 0.5)
    .linkCurvature((l) => state.config.edgeCurvature || 0)
    .linkCurveRotation((l) => (hashStr(linkKey(l)) % 628) / 100)
    .linkDirectionalParticles(state.config.linkParticles ?? 1)
    .linkDirectionalParticleWidth((l) => 0.6 + (l.weight || 0.3) * 1.4)
    .linkDirectionalParticleSpeed(() => 0.004 * (state.config.pulseSpeed ?? 1))
    .linkDirectionalParticleColor((l) => particleColor(l))
    .onNodeHover((n) => {
      container.style.cursor = n ? 'pointer' : 'default';
      callbacks.onHover?.(n ? n.id : null);
    })
    .onNodeClick((n) => callbacks.onClick?.(n))
    .onNodeRightClick((n, evt) => callbacks.onRightClick?.(n, evt))
    .onBackgroundClick(() => callbacks.onBackgroundClick?.())
    .onBackgroundRightClick((evt) => callbacks.onBackgroundRightClick?.(evt));

  // Lock to the right number of dimensions on the d3 simulation
  if (typeof fg.numDimensions === 'function') fg.numDimensions(3);

  // Bloom postprocessing — adds the "neural glow"
  let bloomPass = null;
  try {
    if (state.config.bloom !== false) {
      const THREE = window.THREE || (fg.scene && fg.scene().children && fg.scene().constructor.prototype.constructor);
      attachBloom();
    }
  } catch (e) {
    console.warn('[graph-3d] bloom unavailable', e);
  }

  function attachBloom() {
    const pp = fg.postProcessingComposer?.();
    if (!pp) return;
    const ThreeNS = window.THREE || (typeof THREE !== 'undefined' ? THREE : null);
    if (!ThreeNS || !ThreeNS.UnrealBloomPass) return;
    bloomPass = new ThreeNS.UnrealBloomPass(new ThreeNS.Vector2(window.innerWidth, window.innerHeight), 1.0, 0.6, 0.05);
    bloomPass.strength = 1.1;
    bloomPass.radius = 0.65;
    bloomPass.threshold = 0.05;
    pp.addPass(bloomPass);
  }

  // Track ghost emissive pulses on firing neurons. Three.js node objects are
  // recreated on each data swap; we look up the current Mesh from the graph
  // and animate its material emissiveIntensity.
  const activePulses = new Map(); // nodeId -> {bornMs, baseColor}
  let raf = null;
  function startPulseLoop() {
    if (raf) return;
    const tick = () => {
      const t = performance.now();
      let any = false;
      for (const [id, p] of activePulses) {
        const age = t - p.bornMs;
        if (age >= PULSE_DURATION_MS) { activePulses.delete(id); continue; }
        any = true;
        const mesh = nodeMeshById(id);
        if (mesh && mesh.material) {
          const k = 1 - age / PULSE_DURATION_MS;
          mesh.material.emissive?.setHex?.(p.emissiveHex);
          if ('emissiveIntensity' in mesh.material) {
            mesh.material.emissiveIntensity = k * 2.5 * (state.config.spikeIntensity ?? 1);
          }
          mesh.material.needsUpdate = true;
        }
      }
      if (any) raf = requestAnimationFrame(tick); else { raf = null; }
    };
    raf = requestAnimationFrame(tick);
  }

  function nodeMeshById(id) {
    const data = fg.graphData?.();
    if (!data) return null;
    const n = data.nodes.find((x) => x.id === id);
    return n && n.__threeObj;
  }

  function nodeColor(n) {
    const mode = state.config.colorMode || 'type';
    if (mode === 'region') return styleForRegion(n.region || regionForNode(n)).color;
    if (mode === 'degree') return degreeColor(n.__degree || 0);
    return colorForType(n.type);
  }

  function edgeColor(l) {
    if (state.hoveredId) {
      const s = srcId(l), t = tgtId(l);
      if (s === state.hoveredId || t === state.hoveredId) return '#7c9cff';
      return '#3a4156';
    }
    return '#5a6478';
  }

  function particleColor(l) {
    const sId = srcId(l);
    const node = state.byId.get(sId);
    if (!node) return '#ffffff';
    return styleForRegion(node.region || regionForNode(node)).color;
  }

  function ro() {
    fg.width(container.clientWidth).height(container.clientHeight);
  }
  const obs = new ResizeObserver(ro);
  obs.observe(container);
  ro();

  function applyConfig() {
    const charge = fg.d3Force('charge');
    if (charge) charge.strength(state.config.chargeStrength);
    const link = fg.d3Force('link');
    if (link) {
      link.distance(state.config.linkDistance);
      if (typeof link.strength === 'function') link.strength(state.config.linkStrength);
    }
    const center = fg.d3Force('center');
    if (center && typeof center.strength === 'function') {
      center.strength(state.config.gravity * 4);
    }
    fg.nodeRelSize(state.config.nodeRelSize);
    fg.nodeOpacity(state.config.nodeOpacity ?? 0.95);
    fg.linkOpacity(state.config.edgeOpacity ?? 0.35);
    fg.linkCurvature(state.config.edgeCurvature || 0);
    fg.linkDirectionalParticles(state.config.linkParticles ?? 1);
    fg.linkDirectionalParticleSpeed(0.004 * (state.config.pulseSpeed ?? 1));
    if (typeof fg.d3VelocityDecay === 'function') fg.d3VelocityDecay(state.config.velocityDecay);
    if (typeof fg.d3AlphaDecay === 'function') fg.d3AlphaDecay(state.config.alphaDecay);
    if (bloomPass) bloomPass.strength = state.config.bloom === false ? 0 : 1.1 * (state.config.bgIntensity ?? 0.6) * 1.6;
    fg.refresh?.();
  }

  function setData(graph) {
    if (fourD) applyTemporal(graph);
    else for (const n of graph.nodes) { delete n.fz; }
    fg.graphData(graph);
    applyConfig();
  }

  function applyTemporal(graph) {
    const field = state.config.temporalField || 'createdAt';
    const ts = graph.nodes.map((n) => parseTime(n[field] || n.createdAt));
    const valid = ts.filter((t) => Number.isFinite(t));
    if (valid.length === 0) return;
    const min = Math.min(...valid);
    const max = Math.max(...valid);
    const span = Math.max(1, max - min);
    const stretch = 800 * (state.config.temporalScale ?? 1);
    for (let i = 0; i < graph.nodes.length; i++) {
      const t = ts[i];
      const u = Number.isFinite(t) ? (t - min) / span : 0.5;
      graph.nodes[i].fz = (u - 0.5) * stretch;
    }
  }

  return {
    kind: fourD ? '4d' : '3d',
    fg,
    setData,
    applyConfig,
    refresh() { fg.refresh?.(); },
    fit(ms = 600, pad = 80) { fg.zoomToFit(ms, pad); },
    zoomIn() {
      const cam = fg.camera();
      const dist = cam.position.length();
      cam.position.multiplyScalar(0.7);
      fg.cameraPosition({ x: cam.position.x, y: cam.position.y, z: cam.position.z }, undefined, 250);
    },
    zoomOut() {
      const cam = fg.camera();
      cam.position.multiplyScalar(1.4);
      fg.cameraPosition({ x: cam.position.x, y: cam.position.y, z: cam.position.z }, undefined, 250);
    },
    centerOn(node, ms = 700) {
      if (node.x == null) return;
      const dist = 140;
      const nx = node.x, ny = node.y, nz = node.z || 0;
      const norm = Math.max(1, Math.hypot(nx, ny, nz));
      const k = 1 + dist / norm;
      fg.cameraPosition({ x: nx * k, y: ny * k, z: nz * k }, { x: nx, y: ny, z: nz }, ms);
    },
    screen2GraphCoords() { return { x: 0, y: 0 }; },
    spikeNode(neuronId) {
      const node = state.byId.get(neuronId);
      const region = node && (node.region || regionForNode(node));
      const colorHex = parseHex(styleForRegion(region || 'association').color);
      activePulses.set(neuronId, {
        bornMs: performance.now(),
        emissiveHex: colorHex,
      });
      startPulseLoop();
      // Emit a directional particle on every outgoing edge of this neuron.
      const outs = state.outgoing?.get(neuronId);
      if (outs && typeof fg.emitParticle === 'function') {
        const data = fg.graphData?.();
        if (data) {
          const want = new Set(outs.map((e) => `${srcId(e)}::${tgtId(e)}`));
          for (const link of data.links) {
            const k = `${srcId(link)}::${tgtId(link)}`;
            if (want.has(k)) {
              try { fg.emitParticle(link); } catch {}
            }
          }
        }
      }
    },
    startSpikes() { /* particles are always rendered — nothing to start */ },
    stopSpikes() { activePulses.clear(); },
    destroy() {
      try { obs.disconnect(); } catch {}
      try { fg._destructor?.(); } catch {}
      activePulses.clear();
      if (raf) cancelAnimationFrame(raf);
      raf = null;
      container.innerHTML = '';
    },
  };
}

function escapeLabel(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}

function linkKey(l) {
  return `${srcId(l)}::${tgtId(l)}`;
}

function parseTime(v) {
  if (!v) return NaN;
  if (typeof v === 'number') return v;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : NaN;
}

function parseHex(color) {
  const m = /^#?([0-9a-f]{6})$/i.exec(color);
  if (!m) return 0xffffff;
  return parseInt(m[1], 16);
}

const HEAT = ['#3a4663', '#4a6fa5', '#5dd2ff', '#9b8cff', '#ff9b6b', '#ff6b9d'];
function degreeColor(d) {
  const i = Math.min(HEAT.length - 1, Math.floor(Math.log2(d + 1)));
  return HEAT[i];
}
