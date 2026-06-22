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

import { Selection } from './Selection.js';
import { Focus } from './Focus.js';

export class InteractionManager {
  constructor(graphView, stateManager) {
    this.graphView = graphView;
    this.state = stateManager;
    this._listeners = [];
    this._lastHoveredId = null;

    // Multi-select + ego-focus helpers (see Selection.js / Focus.js).
    this.selection = new Selection();
    this.focus = new Focus({ defaultDepth: this.state.get().focusDepth ?? 2 });

    // Active DOM context menu element (if any) + its dismiss listeners.
    this._contextMenuEl = null;
    this._contextMenuListeners = [];
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
    // Delegate selection semantics to the Selection module (Shift/Cmd/Ctrl =
    // additive multi-select, plain click = replace).
    const { ids, primaryId, multi } = this.selection.applyClick(node.id, e);

    // Keep the StateManager's single-id slice in sync with the primary
    // selection, and surface the full multi-select set alongside it.
    this.state.update({ selectedId: primaryId, selectedIds: ids });

    // Strong brain focus only on a fresh single selection (not when toggling
    // members of a multi-selection on and off).
    if (!multi && primaryId && this.graphView.brainSystem) {
      this.graphView.brainSystem.focusOn(primaryId, 1.25);
    }

    this.graphView._emit?.('selectionchange', { ids, primaryId });

    // Visual feedback
    if (this.graphView.renderer) {
      this.graphView.renderer.applyBrainState?.(this.graphView.brainSystem?.getSnapshot?.());
    }
  }

  _handleBackgroundClick(e) {
    this.selection.clear();
    this.state.update({ selectedId: null, selectedIds: [] });
    this.graphView._emit?.('selectionchange', { ids: [], primaryId: null });

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

  /**
   * Hit-test the node under a mouse event, mirroring _onClick's logic.
   * @returns {object|null} the closest node within the click radius, or null
   */
  _nodeAt(e, radius = 45) {
    const renderer = this.graphView?.renderer;
    const fg = renderer?._fg;
    if (!fg || typeof fg.graphData !== 'function') return null;

    const rect = this.container.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    let graphX = x;
    let graphY = y;
    if (typeof fg.screen2GraphCoords === 'function') {
      const coords = fg.screen2GraphCoords(x, y);
      graphX = coords.x;
      graphY = coords.y;
    }

    const nodes = fg.graphData().nodes || [];
    let closest = null;
    let minDist = Infinity;
    for (const node of nodes) {
      if (node.x == null || node.y == null) continue;
      const dist = Math.hypot(node.x - graphX, node.y - graphY);
      if (dist < minDist && dist < radius) {
        minDist = dist;
        closest = node;
      }
    }
    return closest;
  }

  _onContextMenu(e) {
    e.preventDefault();
    this._closeContextMenu();

    const node = this._nodeAt(e);
    if (!node) {
      // Right-click on empty canvas — nothing to act on.
      return;
    }

    // Right-clicking a node selects it (without disturbing an existing
    // multi-selection that already contains it).
    if (!this.selection.has(node.id)) {
      this.selection.set(node.id);
      this.state.update({
        selectedId: node.id,
        selectedIds: this.selection.toArray(),
      });
    }

    const items = [
      { label: 'Open', action: () => this._menuOpen(node) },
      { label: 'Copy', action: () => this._menuCopy(node) },
      { label: 'Expand', action: () => this._menuExpand(node) },
      { label: 'Delete', action: () => this._menuDelete(node), danger: true },
    ];

    this._openContextMenu(e.clientX, e.clientY, items, node);
  }

  /**
   * Build, position, and show a DOM context menu at the given viewport
   * coordinates. The menu is appended to the interaction container and clamped
   * to stay on-screen.
   */
  _openContextMenu(clientX, clientY, items, node) {
    const menu = document.createElement('div');
    menu.className = 'ui-v2-context-menu';
    menu.setAttribute('role', 'menu');
    Object.assign(menu.style, {
      position: 'fixed',
      zIndex: '10000',
      minWidth: '160px',
      padding: '4px',
      background: 'rgba(17, 22, 38, 0.97)',
      border: '1px solid rgba(122, 162, 247, 0.35)',
      borderRadius: '8px',
      boxShadow: '0 8px 28px rgba(0, 0, 0, 0.45)',
      font: '13px system-ui, sans-serif',
      color: '#e5e9f0',
      userSelect: 'none',
    });

    for (const item of items) {
      const el = document.createElement('div');
      el.className = 'ui-v2-context-menu-item';
      el.setAttribute('role', 'menuitem');
      el.textContent = item.label;
      Object.assign(el.style, {
        padding: '7px 12px',
        borderRadius: '5px',
        cursor: 'pointer',
        color: item.danger ? '#f7768e' : '#e5e9f0',
        transition: 'background 120ms ease',
      });
      el.addEventListener('mouseenter', () => {
        el.style.background = 'rgba(122, 162, 247, 0.18)';
      });
      el.addEventListener('mouseleave', () => {
        el.style.background = 'transparent';
      });
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this._closeContextMenu();
        try {
          item.action();
        } catch (err) {
          console.warn('[InteractionManager] context menu action failed', err);
        }
      });
      menu.appendChild(el);
    }

    // Append first so we can measure for on-screen clamping.
    (this.container || document.body).appendChild(menu);
    const { offsetWidth: w, offsetHeight: h } = menu;
    const maxX = window.innerWidth - w - 4;
    const maxY = window.innerHeight - h - 4;
    menu.style.left = `${Math.max(4, Math.min(clientX, maxX))}px`;
    menu.style.top = `${Math.max(4, Math.min(clientY, maxY))}px`;

    this._contextMenuEl = menu;

    // Dismiss on any outside click, scroll, resize, or Escape.
    const dismiss = (ev) => {
      if (ev && ev.type === 'keydown' && ev.key !== 'Escape') return;
      // Ignore mousedown originating inside the menu — otherwise it would
      // detach the menu before the item's own click handler can fire.
      if (ev && ev.type === 'mousedown' && menu.contains(ev.target)) return;
      this._closeContextMenu();
    };
    const register = (target, type, opts) => {
      target.addEventListener(type, dismiss, opts);
      this._contextMenuListeners.push({ target, type, fn: dismiss, opts });
    };
    // Defer so the originating right-click doesn't immediately close it.
    setTimeout(() => {
      if (!this._contextMenuEl) return;
      register(document, 'mousedown');
      register(document, 'keydown');
      register(window, 'blur');
      register(window, 'resize');
      register(window, 'scroll', true);
    }, 0);

    this.graphView._emit?.('contextmenu', { node, items });
  }

  _closeContextMenu() {
    this._contextMenuListeners.forEach(({ target, type, fn, opts }) => {
      target.removeEventListener(type, fn, opts);
    });
    this._contextMenuListeners = [];

    if (this._contextMenuEl) {
      this._contextMenuEl.remove();
      this._contextMenuEl = null;
    }
  }

  // ==================== CONTEXT MENU ACTIONS ====================

  _menuOpen(node) {
    // "Open" focuses the node strongly via the brain + emits for HUD consumers.
    this.selection.set(node.id);
    this.focus.enter(node.id);
    this.state.update({
      selectedId: node.id,
      selectedIds: this.selection.toArray(),
      focusRootId: node.id,
    });
    this.graphView.brainSystem?.focusOn?.(node.id, 1.4);
    this.graphView._emit?.('node:open', { id: node.id, node });
  }

  _menuCopy(node) {
    // Copy the node id to the clipboard (best-effort) and emit for listeners.
    const text = String(node.id);
    const clip = typeof navigator !== 'undefined' ? navigator.clipboard : null;
    if (clip && typeof clip.writeText === 'function') {
      clip.writeText(text).catch((err) => {
        console.warn('[InteractionManager] clipboard write failed', err);
      });
    }
    this.graphView._emit?.('node:copy', { id: node.id, node, text });
  }

  _menuExpand(node) {
    // "Expand" enters ego-focus on the node's neighborhood and asks the
    // brain/graph to surface neighbors. Emits so the data layer can fetch more.
    this.focus.enter(node.id);
    this.state.update({ focusRootId: node.id, focusDepth: this.focus.depth });
    this.graphView.brainSystem?.focusOn?.(node.id, 1.2);
    this.graphView._emit?.('node:expand', { id: node.id, node, depth: this.focus.depth });
  }

  _menuDelete(node) {
    // Remove from local selection state and emit a delete request — the owning
    // data layer is responsible for the actual removal.
    this.selection.remove(node.id);
    this.state.update((s) => ({
      selectedId: s.selectedId === node.id ? this.selection.primaryId : s.selectedId,
      selectedIds: this.selection.toArray(),
    }));
    this.graphView._emit?.('node:delete', { id: node.id, node });
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
        this._closeContextMenu();
        this.selection.clear();
        this.focus.exit();
        this.state.update({ selectedId: null, selectedIds: [], hoveredId: null });
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
    this._closeContextMenu();
    this._listeners.forEach(({ target, type, fn }) => {
      target.removeEventListener(type, fn);
    });
    this._listeners = [];
  }
}