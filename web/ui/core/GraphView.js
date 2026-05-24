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

    // Basic brain system integration (will become much richer)
    import('../brain/BrainSystem.js').then(({ BrainSystem }) => {
      this.brainSystem = new BrainSystem(this.state);
      
      this.brainSystem.subscribe((snap) => {
        // In the future this will drive rich visual effects on the renderer
        if (this.renderer && this.renderer.updateNodeVisual) {
          for (const [id, act] of snap.nodeActivity) {
            this.renderer.updateNodeVisual(id, {
              __heat: act.heat || act.activation * 0.7,
              __brainScale: 1 + (act.activation || 0) * 0.6,
              __brainAlpha: 0.6 + (act.activation || 0) * 0.4,
            });
          }
        }
      });
    });

    // Interaction layer
    import('../interactions/InteractionManager.js').then(({ InteractionManager }) => {
      this.interactionManager = new InteractionManager(this, this.state);
      this.interactionManager.init(this.container);
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
