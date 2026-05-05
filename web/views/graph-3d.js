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
import { bloomStrengthFor, getQualityTier } from '../hud/quality.js';

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
    // Visual Spec Part 2 §5: UnrealBloomPass(strength=0.85, radius=0.4,
    // threshold=0.6); the actual `strength` is then driven by the current
    // quality tier (perf=0.0 / balanced=0.85 / ultra=1.2).
    bloomPass = new ThreeNS.UnrealBloomPass(
      new ThreeNS.Vector2(window.innerWidth, window.innerHeight),
      0.85, 0.4, 0.6,
    );
    bloomPass.strength = bloomStrengthFor(getQualityTier());
    bloomPass.radius = 0.4;
    bloomPass.threshold = 0.6;
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
    const nodeCount = fg.graphData?.()?.nodes?.length ?? 0;
    const largeGraph = nodeCount > 2000;

    const charge = fg.d3Force('charge');
    if (charge) {
      charge.strength(state.config.chargeStrength);
      if (largeGraph && typeof charge.distanceMax === 'function') {
        charge.distanceMax(250);
      }
    }
    const link = fg.d3Force('link');
    if (link) {
      link.distance(state.config.linkDistance);
      if (typeof link.strength === 'function') link.strength(state.config.linkStrength);
      if (largeGraph && typeof link.iterations === 'function') link.iterations(1);
    }
    const center = fg.d3Force('center');
    if (center && typeof center.strength === 'function') {
      center.strength(state.config.gravity * 4);
    }
    fg.nodeRelSize(state.config.nodeRelSize);
    // Reduce node sphere resolution on large graphs to ease the WebGL vertex
    // budget — 8 segments is still a smooth sphere at normal zoom levels.
    fg.nodeResolution(largeGraph ? 8 : 16);
    fg.nodeOpacity(state.config.nodeOpacity ?? 0.95);
    fg.linkOpacity(state.config.edgeOpacity ?? 0.35);
    fg.linkCurvature(state.config.edgeCurvature || 0);
    // Disable directional particles on large graphs; they add significant GPU
    // load and are hard to read at high density.
    fg.linkDirectionalParticles(largeGraph ? 0 : (state.config.linkParticles ?? 1));
    fg.linkDirectionalParticleSpeed(0.004 * (state.config.pulseSpeed ?? 1));
    if (typeof fg.d3VelocityDecay === 'function') fg.d3VelocityDecay(state.config.velocityDecay);
    const alphaDecay = largeGraph
      ? Math.max(state.config.alphaDecay, 0.04)
      : state.config.alphaDecay;
    if (typeof fg.d3AlphaDecay === 'function') fg.d3AlphaDecay(alphaDecay);
    if (bloomPass) {
      // Spec §5: the `bloom` master toggle still hard-disables; otherwise
      // the bloom strength is driven entirely by the quality tier.
      bloomPass.strength = state.config.bloom === false ? 0 : bloomStrengthFor(getQualityTier());
    }
    fg.refresh?.();
  }

  // Track which nodes/edges we've already shown so newly-arriving ones can
  // get a one-shot birth pulse (matches the 2D renderer's procedural-build
  // animation, but reuses the existing 3D spike pulse + edge particle so we
  // don't add a second WebGL pass).
  const seenNodes3d = new Set();
  const seenEdges3d = new Set();
  let firstSync3d = true;

  function setData(graph) {
    if (fourD) applyTemporal(graph);
    else for (const n of graph.nodes) { delete n.fz; }
    fg.graphData(graph);
    // Ensure the force simulation is running after data load. In pure 3D mode
    // (no fz pinning) the simulation must be active for nodes to spread out;
    // without this the engine can remain paused and all nodes overlap at origin.
    fg.d3ReheatSimulation?.();
    applyConfig();

    const newNodeIds = [];
    const newEdges = [];
    for (const n of graph.nodes) {
      if (!firstSync3d && !seenNodes3d.has(n.id)) newNodeIds.push(n.id);
      seenNodes3d.add(n.id);
    }
    for (const e of graph.links || graph.edges || []) {
      const k = `${srcId(e)}::${tgtId(e)}`;
      if (!firstSync3d && !seenEdges3d.has(k)) newEdges.push(e);
      seenEdges3d.add(k);
    }
    if (firstSync3d) firstSync3d = false;
    // Stagger so big imports don't pulse the entire scene at once.
    newNodeIds.forEach((id, i) => setTimeout(() => api.bornNode(id), i * 35));
    newEdges.forEach((e, i)   => setTimeout(() => api.grewEdge(e), 200 + i * 25));
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

  const api = {
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
    /** New-node animation in 3D — re-uses the existing spike pulse so the
     *  newly-arrived neuron flashes once and outgoing edges spit a particle.
     *  This keeps the visual language consistent with the 2D construction
     *  renderer without doubling the WebGL work. */
    bornNode(neuronId) { try { this.spikeNode(neuronId); } catch {} },
    grewEdge(edge) {
      if (typeof fg.emitParticle === 'function') {
        const data = fg.graphData?.();
        if (!data) return;
        const want = `${srcId(edge)}::${tgtId(edge)}`;
        for (const link of data.links) {
          if (`${srcId(link)}::${tgtId(link)}` === want) {
            try { fg.emitParticle(link); } catch {}
            break;
          }
        }
      }
    },
    thinkWave(rootId) {
      // Emit a BFS cascade of edge particles to mimic a wave of thought.
      if (!rootId || !state.byId.has(rootId)) return;
      const visited = new Set([rootId]);
      let frontier = [rootId];
      let depth = 0;
      const data = fg.graphData?.();
      const linkByKey = new Map();
      if (data) for (const l of data.links) linkByKey.set(`${srcId(l)}::${tgtId(l)}`, l);
      while (frontier.length && depth < 4) {
        const next = [];
        for (const id of frontier) {
          const outs = state.outgoing?.get(id) || [];
          for (const e of outs) {
            const other = srcId(e) === id ? tgtId(e) : srcId(e);
            if (visited.has(other)) continue;
            visited.add(other);
            next.push(other);
            const link = linkByKey.get(`${srcId(e)}::${tgtId(e)}`);
            if (link && typeof fg.emitParticle === 'function') {
              setTimeout(() => { try { fg.emitParticle(link); } catch {} }, depth * 280);
            }
          }
        }
        frontier = next;
        depth += 1;
      }
    },
    destroy() {
      try { obs.disconnect(); } catch {}
      try { fg._destructor?.(); } catch {}
      activePulses.clear();
      if (raf) cancelAnimationFrame(raf);
      raf = null;
      container.innerHTML = '';
    },
  };
  return api;
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
