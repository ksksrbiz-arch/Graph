/**
 * InteractionManager v2 — High-Effort Interaction Layer
 *
 * Handles all user input for the new Graph UI:
 * - Mouse: click to select/focus, hover, right-click context (future)
 * - Keyboard: navigation, focus, mode triggers
 * - Coordinates with GraphView, BrainSystem, and Renderer
 *
 * Designed to feel premium and responsive.
 */

export class InteractionManager {
  constructor(graphView, stateManager) {
    this.graphView = graphView;
    this.state = stateManager;
    this._listeners = [];
    this._lastHoveredId = null;
  }

  init(container) {
    if (!container) {
      console.warn('[InteractionManager] No container provided');
      return;
    }

    this.container = container;

    // Mouse interactions
    this._addListener(container, 'click', this._onClick.bind(this));
    this._addListener(container, 'mousemove', this._onMouseMove.bind(this));
    this._addListener(container, 'mouseleave', this._onMouseLeave.bind(this));
    this._addListener(container, 'contextmenu', this._onContextMenu.bind(this));

    // Keyboard (document level for better UX)
    this._addListener(document, 'keydown', this._onKeyDown.bind(this));

    console.log('%c[InteractionManager] Fully initialized with real interactions', 'color:#67e8f9');
  }

  _addListener(target, type, fn) {
    target.addEventListener(type, fn);
    this._listeners.push({ target, type, fn });
  }

  // ==================== MOUSE ====================

  _onClick(e) {
    const renderer = this.graphView?.renderer;
    if (!renderer || !renderer._fg) return;

    const fg = renderer._fg;
    const rect = this.container.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Use force-graph's internal screen2GraphCoords if available
    let graphX = x;
    let graphY = y;

    if (typeof fg.screen2GraphCoords === 'function') {
      const coords = fg.screen2GraphCoords(x, y);
      graphX = coords.x;
      graphY = coords.y;
    }

    // Find closest node
    const nodes = fg.graphData().nodes || [];
    let closest = null;
    let minDist = Infinity;

    for (const node of nodes) {
      if (node.x == null || node.y == null) continue;
      const dist = Math.hypot(node.x - graphX, node.y - graphY);
      if (dist < minDist && dist < 45) {
        minDist = dist;
        closest = node;
      }
    }

    if (closest) {
      this._handleNodeClick(closest, e);
    } else {
      this._handleBackgroundClick(e);
    }
  }

  _handleNodeClick(node, e) {
    const isMulti = e.shiftKey || e.metaKey;

    if (isMulti) {
      // Future: multi-select
      this.state.update(s => ({
        selectedId: s.selectedId === node.id ? null : node.id
      }));
    } else {
      // Single select + strong brain focus
      this.state.update({ selectedId: node.id });

      if (this.graphView.brainSystem) {
        this.graphView.brainSystem.focusOn(node.id, 1.25);
      }
    }

    // Visual feedback
    if (this.graphView.renderer) {
      this.graphView.renderer.applyBrainState?.(this.graphView.brainSystem?.getSnapshot?.());
    }
  }

  _handleBackgroundClick(e) {
    this.state.update({ selectedId: null });

    if (this.graphView.brainSystem) {
      // Mild global "reset" pulse
      this.graphView.brainSystem.exitDreamMode?.();
    }
  }

  _onMouseMove(e) {
    const renderer = this.graphView?.renderer;
    if (!renderer || !renderer._fg) return;

    const fg = renderer._fg;
    const rect = this.container.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    let graphX = x, graphY = y;
    if (typeof fg.screen2GraphCoords === 'function') {
      const coords = fg.screen2GraphCoords(x, y);
      graphX = coords.x; graphY = coords.y;
    }

    const nodes = fg.graphData().nodes || [];
    let closest = null;
    let minDist = Infinity;

    for (const node of nodes) {
      if (node.x == null || node.y == null) continue;
      const dist = Math.hypot(node.x - graphX, node.y - graphY);
      if (dist < minDist && dist < 35) {
        minDist = dist;
        closest = node;
      }
    }

    const hoveredId = closest ? closest.id : null;

    if (hoveredId !== this._lastHoveredId) {
      this._lastHoveredId = hoveredId;
      this.state.update({ hoveredId });

      // Light brain reaction on hover
      if (hoveredId && this.graphView.brainSystem) {
        this.graphView.brainSystem._setNodeActivity?.(hoveredId, 0.35, 'hover');
      }
    }
  }

  _onMouseLeave() {
    this.state.update({ hoveredId: null });
    this._lastHoveredId = null;
  }

  _onContextMenu(e) {
    e.preventDefault();
    // Future: rich context menu
    console.log('[InteractionManager] Context menu requested');
  }

  // ==================== KEYBOARD ====================

  _onKeyDown(e) {
    const key = e.key.toLowerCase();

    if (!this.graphView.brainSystem) return;

    switch (key) {
      case 'd':
        this.graphView.brainSystem.enterDreamMode(0.9);
        break;
      case 'a':
        this.graphView.brainSystem.exitDreamMode();
        break;
      case 'f':
        if (this.state.get().selectedId) {
          this.graphView.brainSystem.focusOn(this.state.get().selectedId, 1.3);
        }
        break;
      case 'escape':
        this.state.update({ selectedId: null, hoveredId: null });
        this.graphView.brainSystem.exitDreamMode();
        break;
      case 'r':
        if (this.graphView.renderer?.fit) {
          this.graphView.renderer.fit(380);
        }
        break;
    }
  }

  destroy() {
    this._listeners.forEach(({ target, type, fn }) => {
      target.removeEventListener(type, fn);
    });
    this._listeners = [];
  }
}