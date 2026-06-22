/**
 * GraphView — The main orchestrator for the rebuilt high-effort Graph UI v2.
 *
 * Responsibilities:
 * - Own the lifecycle
 * - Coordinate State, Renderers, Brain System, and Interactions
 * - Provide a clean public API
 *
 * This is intentionally kept relatively thin. Heavy logic lives in specialized modules.
 */

import { StateManager } from './StateManager.js';

export class GraphView {
  constructor(container, options = {}) {
    this.container = container;
    this.options = options;

    this.state = new StateManager(options.initialState);

    this.renderer = null;
    this.brainSystem = null;
    this.interactionManager = null;

    this._isDestroyed = false;

    this._init();
  }

  _init() {
    this.container.innerHTML = `
      <div class="ui-v2-root">
        <div class="ui-v2-canvas" id="ui-v2-canvas"></div>
        <div class="ui-v2-hud">
          <div class="ui-v2-status">Graph UI v2 — High Effort Rebuild (Early)</div>
        </div>
      </div>
    `;

    const canvasContainer = this.container.querySelector('#ui-v2-canvas');

    // Initialize core systems — mount the renderer for the current dimension
    // mode (2d → Graph2DRenderer, 3d/4d → Graph3DRenderer).
    this.renderer = null;
    void this._mountRenderer(this.state.get().config?.dimensions || '2d');

    // === Full Brain + Renderer Integration (Maximum Effort) ===
    import('../brain/BrainSystem.js').then(({ BrainSystem }) => {
      this.brainSystem = new BrainSystem(this.state);

      this.brainSystem.subscribe((snap) => {
        // Push the rich brain state into the renderer every frame
        if (this.renderer && this.renderer.applyBrainState) {
          this.renderer.applyBrainState(snap);
        }
      });
    });

    // Animation orchestrator — sequences brain visual effects (spawn pulses,
    // query traces, inference arcs) on a rAF loop, fed by BrainSystem events.
    import('../brain/AnimationOrchestrator.js')
      .then(({ AnimationOrchestrator }) => {
        this.animator = new AnimationOrchestrator();
        this.animator.start();
      })
      .catch((e) => console.warn('[GraphView] AnimationOrchestrator load failed', e));

    // Full Interaction layer (now properly implemented)
    import('../interactions/InteractionManager.js').then(({ InteractionManager }) => {
      this.interactionManager = new InteractionManager(this, this.state);
      this.interactionManager.init(this.container);
    });

    // React to selection/hover changes for renderer visuals
    this.state.subscribe('selectedId', (id) => {
      if (this.renderer && this.renderer.applyBrainState) {
        const snap = this.brainSystem?.getSnapshot?.() || {};
        this.renderer.applyBrainState(snap);
        // Force selected visual
        if (this.renderer._fg?.graphData) {
          const nodes = this.renderer._fg.graphData().nodes || [];
          nodes.forEach(n => n.__selected = n.id === id);
        }
      }
    });

    this.state.subscribe('hoveredId', (id) => {
      if (this.renderer && this.renderer._fg?.graphData) {
        const nodes = this.renderer._fg.graphData().nodes || [];
        nodes.forEach(n => n.__hovered = n.id === id);
      }
    });

    console.log('%c[Graph UI v2] High-effort rebuild initialized. BrainSystem + Renderer foundation wired.', 'color:#7aa2f7');
  }

  /**
   * Load a new graph dataset.
   */
  async setGraph(graphData) {
    // Use DataBridge to support both new v2 shape and legacy project data
    let normalized;
    try {
      const { DataBridge } = await import('./DataBridge.js');
      const bridge = new DataBridge();
      normalized = bridge.normalizeGraph(graphData);
    } catch (e) {
      console.warn('[GraphView] DataBridge import failed, using raw data', e);
      normalized = {
        nodes: (graphData.nodes || graphData.graph?.nodes || []).map(n => ({ ...n })),
        edges: (graphData.edges || graphData.graph?.edges || []).map(e => ({ ...e })),
      };
    }

    this.state.setGraph(normalized);

    if (this.renderer) {
      this.renderer.setData(this.state.get());
    }

    // Feed new nodes into the brain system + fire spawn-pulse effects.
    if (this.brainSystem && normalized.nodes?.length) {
      const ids = normalized.nodes.map(n => n.id);
      this.brainSystem.onNodesArrived(ids, 0.65);
      if (this.animator) {
        for (const id of ids.slice(0, 40)) this.animator.trigger('spawn-pulse', { nodeId: id });
      }
    }
  }

  /**
   * Switch between 2D / 3D / Temporal renderers.
   */
  setDimensions(dim) {
    this.state.setConfig({ dimensions: dim });
    void this._mountRenderer(dim);
  }

  /**
   * (Re)mount the renderer appropriate for a dimension mode. Tears down any
   * existing renderer, loads the 2D or 3D implementation, and re-applies the
   * current data + brain snapshot.
   * @param {string} mode  '2d' | '3d' | '4d' | 'temporal'
   */
  async _mountRenderer(mode = '2d') {
    const container = this.container.querySelector('#ui-v2-canvas');
    if (!container) return;
    if (this.renderer?.destroy) this.renderer.destroy();
    this.renderer = null;
    try {
      const is3d = mode === '3d' || mode === '4d' || mode === 'temporal';
      if (is3d) {
        const { createGraph3DRenderer } = await import('../renderers/Graph3DRenderer.js');
        this.renderer = createGraph3DRenderer(container);
        this.renderer?.setMode?.(mode === 'temporal' ? '4d' : mode);
      } else {
        const { createGraph2DRenderer } = await import('../renderers/Graph2DRenderer.js');
        this.renderer = createGraph2DRenderer(container);
      }
      if (this.renderer && this.state.get().nodes.size > 0) {
        this.renderer.setData(this.state.get());
      }
      const snap = this.brainSystem?.getSnapshot?.();
      if (snap && this.renderer?.applyBrainState) this.renderer.applyBrainState(snap);
    } catch (e) {
      console.warn('[GraphView] renderer mount failed for mode', mode, e);
    }
  }

  /**
   * Destroy the entire view and clean up resources.
   */
  destroy() {
    if (this._isDestroyed) return;
    this._isDestroyed = true;

    if (this.interactionManager?.destroy) this.interactionManager.destroy();
    if (this.animator?.stop) this.animator.stop();
    if (this.renderer?.destroy) this.renderer.destroy();
    if (this.brainSystem?.destroy) this.brainSystem.destroy();

    this.container.innerHTML = '';
  }

  // ==================== Event System (for future consumers) ====================
  _events = new Map();

  on(event, handler) {
    if (!this._events.has(event)) this._events.set(event, new Set());
    this._events.get(event).add(handler);
    return () => this._events.get(event)?.delete(handler);
  }

  _emit(event, payload) {
    this._events.get(event)?.forEach(fn => {
      try { fn(payload); } catch (e) { console.warn('[GraphView] event handler error', e); }
    });
  }

  /**
   * Configure the view at runtime (brain intensity, visual settings, etc.)
   */
  configure(config = {}) {
    if (config.brainIntensity !== undefined && this.brainSystem) {
      this.brainSystem.modes.intensity = config.brainIntensity;
    }

    if (this.state) {
      this.state.setConfig(config);
    }

    if (this.renderer) {
      // Allow renderer to react to config changes
      this.renderer.applyBrainState?.(this.brainSystem?.getSnapshot?.());
    }
  }

  /**
   * Clean public API for consumers
   */
  get brain() {
    return this.brainSystem;
  }

  get rendererApi() {
    return this.renderer;
  }
}
