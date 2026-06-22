/**
 * Graph3DRenderer v2 — High-Effort 3D Renderer
 *
 * A volumetric counterpart to {@link Graph2DRenderer}. It speaks the exact
 * same renderer contract (see {@link BaseRenderer}) so {@link GraphView} can
 * swap between 2D and 3D without any special-casing:
 *
 *   setData(graphData)      load / replace the graph
 *   applyBrainState(snap)   per-frame brain state (heat → emissive pulses)
 *   fit(), zoomIn(), zoomOut()
 *   setMode('3d' | '4d')    toggle the temporal Z axis
 *   focusNode(id)           orbit the camera onto a node
 *   destroy()
 *
 * Rendering is delegated to the `3d-force-graph` CDN global
 * (`window.ForceGraph3D`, Three.js + d3-force-3d) — exactly the same global
 * the v1 viewer loads via `web/vendor/3d-force-graph.min.js` (see
 * `web/views/graph-3d.js`). We never bundle or import THREE; if the global is
 * absent the renderer degrades gracefully to a visible "not loaded" notice and
 * a fully inert (but safe-to-call) API, mirroring how the rest of the codebase
 * guards CDN globals.
 *
 * Self-contained: no imports from sibling UI modules except the shared
 * data-normalization helper on BaseRenderer.
 */

import { BaseRenderer } from './BaseRenderer.js';

const TEMPORAL_STRETCH = 800; // Z spread (px) when in 4D / temporal mode.
const MAX_TEMPORAL_FALLBACK = 280;
const FOCUS_CAM_DISTANCE = 140;

/**
 * Build the inert no-op API returned when `ForceGraph3D` is unavailable.
 * Every contract method exists so callers never have to feature-detect.
 * @param {HTMLElement} container
 * @returns {import('./BaseRenderer.js').RendererApi}
 */
function createInertRenderer(container) {
  if (container) {
    container.innerHTML =
      '<div class="empty" style="padding:2rem; color:#f66;">3D renderer failed to load (window.ForceGraph3D / vendor/3d-force-graph.min.js).</div>';
  }
  return {
    kind: '3d',
    available: false,
    setData() {},
    applyBrainState() {},
    fit() {},
    zoomIn() {},
    zoomOut() {},
    setMode() {},
    focusNode() {},
    refresh() {},
    destroy() {
      if (container) container.innerHTML = '';
    },
    _fg: null,
  };
}

/**
 * Create a 3D renderer bound to `container`.
 *
 * @param {HTMLElement} container Host element.
 * @param {object} [options]
 * @param {boolean} [options.fourD=false] Start in 4D (temporal Z axis) mode.
 * @returns {import('./BaseRenderer.js').RendererApi|null}
 */
export function createGraph3DRenderer(container, options = {}) {
  if (!container) return null;

  if (typeof window === 'undefined' || typeof window.ForceGraph3D !== 'function') {
    return createInertRenderer(container);
  }

  container.innerHTML = '';

  let fg;
  try {
    fg = window.ForceGraph3D({
      controlType: 'orbit',
      rendererConfig: { antialias: true, alpha: true },
    })(container);

    fg
      .backgroundColor('rgba(8,10,16,1)')
      .showNavInfo(false)
      .nodeId('id')
      .nodeLabel((n) => escapeLabel(n.label || n.id))
      .nodeRelSize(5.5)
      .nodeVal((n) => Math.max(1, Math.sqrt(n.__degree || 1) * 3))
      .nodeColor((n) => n.__color || getNodeColor(n))
      .nodeOpacity(0.95)
      .nodeResolution(16)
      .linkColor(() => 'rgba(110, 130, 255, 0.35)')
      .linkOpacity(0.35)
      .linkWidth((l) => 0.2 + (l.weight || 0.3) * 0.8)
      .linkDirectionalParticles(1)
      .linkDirectionalParticleWidth((l) => 0.6 + (l.weight || 0.3) * 1.4)
      .linkDirectionalParticleSpeed(0.004)
      .linkDirectionalParticleColor(() => '#a5b4fc')
      .onNodeHover((n) => {
        container.style.cursor = n ? 'pointer' : 'default';
      });
  } catch (err) {
    console.warn('[Graph3DRenderer] renderer init failed', err);
    try { fg?._destructor?.(); } catch { /* noop */ }
    return createInertRenderer(container);
  }

  let fourD = !!options.fourD;
  let brainSnapshot = null;
  let destroyed = false;

  // Track one-shot emissive pulses on firing neurons. Three.js node meshes are
  // recreated on each data swap, so we look the current mesh up by id and
  // animate its material rather than holding a reference.
  const activePulses = new Map(); // nodeId -> { bornMs }
  const PULSE_DURATION_MS = 700;
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
          if ('emissiveIntensity' in mesh.material) {
            mesh.material.emissiveIntensity = k * 2.5;
          }
          mesh.material.needsUpdate = true;
        }
      }
      raf = any ? requestAnimationFrame(tick) : null;
    };
    raf = requestAnimationFrame(tick);
  }

  function nodeMeshById(id) {
    const data = fg.graphData?.();
    if (!data?.nodes) return null;
    const n = data.nodes.find((x) => x.id === id);
    return n && n.__threeObj;
  }

  function getNodeColor(node) {
    const type = (node.type || '').toLowerCase();
    if (type.includes('person')) return '#f472b6';
    if (type.includes('note')) return '#60a5fa';
    if (type.includes('code') || type.includes('commit')) return '#34d399';
    if (type.includes('task')) return '#fbbf24';
    if (type.includes('image')) return '#a78bfa';
    return '#7aa2f7';
  }

  /**
   * Pin each node's Z coordinate to a normalised function of its timestamp,
   * producing the "tree of time" temporal axis. Mirrors web/views/graph-3d.js.
   * @param {{nodes: any[]}} graph
   */
  function applyTemporal(graph) {
    const times = graph.nodes.map((n) => parseTime(n.createdAt ?? n.updatedAt));
    let min = Infinity;
    let max = -Infinity;
    for (const t of times) {
      if (!Number.isFinite(t)) continue;
      if (t < min) min = t;
      if (t > max) max = t;
    }
    const span = max - min;
    if (!Number.isFinite(span) || span < 1) {
      // No usable timestamps — spread deterministically by id hash instead.
      for (const n of graph.nodes) {
        const h = (hashStr(String(n.id || '')) >>> 0) / 0xffffffff;
        n.fz = (h - 0.5) * MAX_TEMPORAL_FALLBACK;
        n.z = n.fz;
      }
      return;
    }
    for (let i = 0; i < graph.nodes.length; i++) {
      const t = times[i];
      const u = Number.isFinite(t) ? (t - min) / span : 0.5;
      graph.nodes[i].fz = (u - 0.5) * TEMPORAL_STRETCH;
      graph.nodes[i].z = graph.nodes[i].fz;
    }
  }

  /**
   * Remove temporal Z pinning so the sim is free in pure-3D mode. We also zero
   * the residual `z`: deleting `fz` alone leaves each node frozen at its last
   * temporal coordinate, so a 4D→3D switch would stay flat/stretched.
   */
  function clearTemporal(graph) {
    for (const n of graph.nodes) {
      delete n.fz;
      n.z = 0;
    }
  }

  // Resize handling — identical pattern to the 2D renderer.
  const ro = new ResizeObserver(() => {
    if (destroyed) return;
    fg.width(container.clientWidth).height(container.clientHeight);
  });
  ro.observe(container);
  fg.width(container.clientWidth).height(container.clientHeight);

  /** @type {import('./BaseRenderer.js').RendererApi} */
  const api = {
    kind: fourD ? '4d' : '3d',
    available: true,

    setData(graphData) {
      const graph = BaseRenderer.toForceGraphData(graphData);
      if (fourD) applyTemporal(graph);
      else clearTemporal(graph);
      fg.graphData(graph);
      // Ensure the simulation runs after a load; without a reheat the engine
      // can stay paused and leave every node stacked at the origin.
      fg.d3ReheatSimulation?.();
    },

    /**
     * Push the latest brain snapshot. Active neurons get a one-shot emissive
     * pulse; the heat is also stashed on the node for any downstream use.
     * @param {*} snap
     */
    applyBrainState(snap) {
      brainSnapshot = snap;
      const data = fg.graphData?.();
      if (!data?.nodes) return;

      const nodeMap = new Map(data.nodes.map((n) => [n.id, n]));
      for (const node of nodeMap.values()) {
        node.__heat = 0;
        node.__focused = false;
      }

      if (snap?.nodeActivity) {
        for (const [id, act] of snap.nodeActivity) {
          const node = nodeMap.get(id);
          if (!node) continue;
          const heat = Number.isFinite(act.heat) ? act.heat : (act.activation || 0) * 0.75;
          node.__heat = heat;
          // Strong activity flashes the neuron.
          if (heat > 0.2 && !activePulses.has(id)) {
            activePulses.set(id, { bornMs: performance.now() });
          }
        }
        if (activePulses.size) startPulseLoop();
      }

      if (snap?.attention?.globalFocus) {
        const focused = nodeMap.get(snap.attention.globalFocus);
        if (focused) focused.__focused = true;
      }
    },

    fit(duration = 600, padding = 80) {
      fg.zoomToFit(duration, padding);
    },

    zoomIn() {
      const cam = fg.camera();
      cam.position.multiplyScalar(0.7);
      fg.cameraPosition({ x: cam.position.x, y: cam.position.y, z: cam.position.z }, undefined, 250);
    },

    zoomOut() {
      const cam = fg.camera();
      cam.position.multiplyScalar(1.4);
      fg.cameraPosition({ x: cam.position.x, y: cam.position.y, z: cam.position.z }, undefined, 250);
    },

    /**
     * Toggle between pure 3D and 4D temporal layout.
     * @param {'3d'|'4d'|string} mode
     */
    setMode(mode) {
      const next = mode === '4d';
      if (next === fourD) return;
      fourD = next;
      api.kind = fourD ? '4d' : '3d';
      const data = fg.graphData?.();
      if (data) api.setData(data); // re-pin / unpin Z and reheat
    },

    /**
     * Orbit the camera onto a node.
     * @param {string} nodeId
     * @param {object} [opts]
     * @param {number} [opts.duration=700]
     */
    focusNode(nodeId, opts = {}) {
      const data = fg.graphData?.();
      const node = data?.nodes?.find((n) => n.id === nodeId);
      if (!node || !Number.isFinite(node.x) || !Number.isFinite(node.y)) return;
      const nx = node.x, ny = node.y, nz = node.z || 0;
      const norm = Math.max(1, Math.hypot(nx, ny, nz));
      const k = 1 + FOCUS_CAM_DISTANCE / norm;
      fg.cameraPosition(
        { x: nx * k, y: ny * k, z: nz * k },
        { x: nx, y: ny, z: nz },
        opts.duration ?? 700,
      );
    },

    refresh() {
      fg.refresh?.();
    },

    destroy() {
      destroyed = true;
      try { ro.disconnect(); } catch { /* noop */ }
      if (raf) cancelAnimationFrame(raf);
      raf = null;
      activePulses.clear();
      try { fg._destructor?.(); } catch { /* noop */ }
      container.innerHTML = '';
    },

    _fg: fg,
  };

  return api;
}

// ── Local helpers (self-contained — no cross-module imports) ─────────────────

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

function parseTime(v) {
  if (v == null) return NaN;
  if (typeof v === 'number') return v;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : NaN;
}

export default createGraph3DRenderer;
