/**
 * BaseRenderer — the shared renderer contract for Graph UI v2.
 *
 * Every renderer (2D canvas, 3D/4D WebGL, future temporal/VR, …) speaks the
 * same small interface so the {@link GraphView} orchestrator can swap one for
 * another without caring how pixels actually get drawn. `Graph2DRenderer`
 * (a factory returning a plain API object) and `Graph3DRenderer` conceptually
 * implement this surface; this module both documents that contract and offers
 * an optional base class with safe no-op defaults so subclasses only override
 * what they support.
 *
 * Note: the v1 track is zero-dependency vanilla ESM. The existing
 * `Graph2DRenderer` is written as a factory function rather than a class —
 * either style is fine as long as the returned object exposes the methods
 * below. This base class is provided for convenience and discoverability, not
 * as a hard requirement.
 *
 * ── The renderer contract ──────────────────────────────────────────────────
 *
 * Core (implemented by every renderer):
 *   setData(graphData)        Load/replace the graph. `graphData` is the
 *                             StateManager state (or a `{ nodes, links }` /
 *                             `{ nodes, edges }` shape). Renderers must accept
 *                             both Map-based state and plain arrays.
 *   applyBrainState(snap)     Push the latest BrainSystem snapshot into the
 *                             renderer each frame (heat/glow/activation,
 *                             attention focus, particles). Optional but
 *                             strongly recommended — GraphView feature-detects
 *                             it before calling.
 *   destroy()                 Tear down observers, animation frames, and the
 *                             underlying graph instance; empty the container.
 *
 * Camera / viewport:
 *   fit(duration, padding)    Zoom/scale so the whole graph is visible.
 *   zoomIn()                  Zoom toward the graph.
 *   zoomOut()                 Zoom away from the graph.
 *
 * Lifecycle / selection helpers (optional — default to no-ops here):
 *   mount(element)            Attach the renderer to a DOM element. Factory
 *                             renderers do this at construction; class-based
 *                             renderers may defer it.
 *   update()                 Request a redraw / refresh of the current frame.
 *   setMode(mode)            Switch a renderer sub-mode (e.g. 3D ↔ 4D temporal,
 *                             color mode). No-op if unsupported.
 *   focusNode(nodeId, opts)  Center/highlight a single node.
 *
 * Introspection:
 *   kind                     Short string identifying the renderer
 *                            ('2d' | '3d' | '4d' | …). Used by GraphView to
 *                            decide whether a renderer swap is needed.
 *
 * @typedef {Object} RendererApi
 * @property {string}   [kind]
 * @property {(graphData: any) => void} setData
 * @property {(snapshot: any) => void}  [applyBrainState]
 * @property {(duration?: number, padding?: number) => void} [fit]
 * @property {() => void} [zoomIn]
 * @property {() => void} [zoomOut]
 * @property {(element: HTMLElement) => void} [mount]
 * @property {() => void} [update]
 * @property {(mode: string) => void} [setMode]
 * @property {(nodeId: string, opts?: object) => void} [focusNode]
 * @property {() => void} destroy
 */

/**
 * Optional base class providing safe no-op defaults for the renderer contract.
 *
 * Subclasses should call `super(container, options)` and override at least
 * {@link BaseRenderer#setData} and {@link BaseRenderer#destroy}. Methods left
 * unoverridden simply do nothing, so a partially-capable renderer is still a
 * valid `RendererApi`.
 *
 * @abstract
 */
export class BaseRenderer {
  /**
   * @param {HTMLElement} [container] Host element the renderer draws into.
   * @param {object} [options] Renderer-specific options.
   */
  constructor(container = null, options = {}) {
    /** @type {HTMLElement|null} */
    this.container = container;
    /** @type {object} */
    this.options = options || {};
    /** @type {string} Short renderer identifier; subclasses override. */
    this.kind = 'base';
    /** @type {boolean} */
    this._destroyed = false;
    /** @type {*} Most recent graph payload handed to {@link setData}. */
    this._graphData = null;
    /** @type {*} Most recent brain snapshot. */
    this._brainSnapshot = null;
  }

  // ── Core ──────────────────────────────────────────────────────────────────

  /**
   * Attach the renderer to a DOM element. Default implementation just records
   * the element; factory-style renderers mount at construction instead.
   * @param {HTMLElement} element
   */
  mount(element) {
    this.container = element;
  }

  /**
   * Load or replace the graph data. Subclasses MUST override.
   * @param {*} graphData StateManager state or `{ nodes, links|edges }`.
   */
  setData(graphData) {
    this._graphData = graphData;
  }

  /**
   * Push the latest BrainSystem snapshot for this frame. No-op by default.
   * @param {*} snapshot
   */
  applyBrainState(snapshot) {
    this._brainSnapshot = snapshot;
  }

  /**
   * Request a redraw of the current frame. No-op by default.
   */
  update() {}

  // ── Camera / viewport ──────────────────────────────────────────────────────

  /**
   * Fit the entire graph in view.
   * @param {number} [duration]
   * @param {number} [padding]
   */
  fit(duration, padding) {} // eslint-disable-line no-unused-vars

  /** Zoom toward the graph. */
  zoomIn() {}

  /** Zoom away from the graph. */
  zoomOut() {}

  // ── Optional helpers ────────────────────────────────────────────────────────

  /**
   * Switch a renderer sub-mode (e.g. color mode, 3D↔4D). No-op by default.
   * @param {string} mode
   */
  setMode(mode) {} // eslint-disable-line no-unused-vars

  /**
   * Center / highlight a single node. No-op by default.
   * @param {string} nodeId
   * @param {object} [opts]
   */
  focusNode(nodeId, opts) {} // eslint-disable-line no-unused-vars

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  /**
   * Tear down the renderer. Subclasses SHOULD override to release the
   * underlying graph instance, observers, and animation frames, then call
   * `super.destroy()` (or set `_destroyed` themselves).
   */
  destroy() {
    this._destroyed = true;
    this._graphData = null;
    this._brainSnapshot = null;
    if (this.container) {
      try { this.container.innerHTML = ''; } catch { /* detached node */ }
    }
  }

  // ── Shared utilities ─────────────────────────────────────────────────────────

  /**
   * Normalize whatever GraphView hands a renderer into the
   * `{ nodes: [], links: [] }` shape that the force-graph globals expect.
   *
   * Accepts:
   *   - StateManager state: `{ nodes: Map, edges: Map }`
   *   - `{ nodes: [], links: [] }`
   *   - `{ nodes: [], edges: [] }`
   *
   * Edges are mapped to `links` (force-graph's term) without mutating the
   * input. Node/edge objects are passed through by reference so live physics
   * coordinates (`x`/`y`/`z`) survive across re-reads.
   *
   * @param {*} graphData
   * @returns {{ nodes: any[], links: any[] }}
   */
  static toForceGraphData(graphData) {
    if (!graphData) return { nodes: [], links: [] };

    const nodes = BaseRenderer._collection(graphData.nodes);
    // Prefer explicit links; fall back to edges (the v1/StateManager term).
    const linkSource = graphData.links != null ? graphData.links : graphData.edges;
    const links = BaseRenderer._collection(linkSource);

    return { nodes, links };
  }

  /**
   * Coerce a Map | array | iterable | null into a plain array.
   * @param {*} value
   * @returns {any[]}
   * @private
   */
  static _collection(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (value instanceof Map) return Array.from(value.values());
    if (typeof value[Symbol.iterator] === 'function') return Array.from(value);
    return [];
  }
}

export default BaseRenderer;
