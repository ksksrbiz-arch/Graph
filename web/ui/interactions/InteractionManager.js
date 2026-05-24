/**
 * InteractionManager v2
 * 
 * Responsible for all user interaction with the graph:
 * - Selection, multi-selection
 * - Focus / ego network
 * - Panning, zooming (delegated to renderer but coordinated here)
 * - Hover, context menus, keyboard navigation
 * - Gesture handling (future)
 */

export class InteractionManager {
  constructor(graphView, stateManager) {
    this.graphView = graphView;
    this.state = stateManager;
    this._listeners = [];
  }

  init(renderer) {
    // In a full implementation this would attach listeners to the canvas
    // and translate them into state changes + commands.
    console.log('[InteractionManager] Initialized (scaffolding)');
  }

  destroy() {
    this._listeners.forEach(({ target, type, fn }) => target.removeEventListener(type, fn));
    this._listeners = [];
  }
}
