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

    // Initialize core systems
    this.renderer = null;
    try {
      // Dynamically import to keep things clean
      import('../renderers/Graph2DRenderer.js').then(({ createGraph2DRenderer }) => {
        this.renderer = createGraph2DRenderer(canvasContainer);
        if (this.renderer && this.state.get().nodes.size > 0) {
          this.renderer.setData(this.state.get());
        }
      });
    } catch (e) {
      console.warn('[GraphView] Could not load 2D renderer yet', e);
    }

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
  setGraph(graphData) {
    this.state.setGraph(graphData);

    if (this.renderer) {
      this.renderer.setData(this.state.get());
    }

    // Feed new nodes into the brain system so it feels alive immediately
    if (this.brainSystem && graphData.nodes) {
      const ids = graphData.nodes.map(n => n.id);
      this.brainSystem.onNodesArrived(ids, 0.65);
    }
  }

  /**
   * Switch between 2D / 3D / Temporal renderers.
   */
  setDimensions(dim) {
    this.state.setConfig({ dimensions: dim });
    // Renderer switching logic will go here
  }

  /**
   * Destroy the entire view and clean up resources.
   */
  destroy() {
    if (this._isDestroyed) return;
    this._isDestroyed = true;

    if (this.renderer?.destroy) this.renderer.destroy();
    if (this.brainSystem?.destroy) this.brainSystem.destroy();

    this.container.innerHTML = '';
  }
}
