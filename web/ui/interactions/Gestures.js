/**
 * Gestures — Minimal but real pointer-gesture detection for Graph UI v2.
 *
 * Wraps a container's pointer events and recognizes two gestures that the
 * higher-level InteractionManager (or a renderer) can consume:
 *
 * - drag   : single pointer pressed and moved past a small threshold
 * - pinch  : two pointers, reported as a zoom scale relative to the initial
 *            distance between them (touch / trackpad multi-touch)
 *
 * It deliberately does NOT implement panning/zoom itself — force-graph already
 * owns the canvas camera. This layer only *detects* and emits gesture events so
 * other modules can react (e.g. suppress a click after a drag, or surface a
 * pinch ratio). It is renderer- and state-agnostic, vanilla ESM, zero-dep.
 *
 * Uses Pointer Events, which unify mouse / touch / pen, and tracks listeners
 * the same way InteractionManager does so cleanup is symmetric.
 */

const DEFAULT_DRAG_THRESHOLD = 4; // px before a press counts as a drag

export class Gestures {
  /**
   * @param {{ dragThreshold?: number }} [options]
   */
  constructor({ dragThreshold = DEFAULT_DRAG_THRESHOLD } = {}) {
    this.dragThreshold = dragThreshold;

    /** @type {Map<number, { x: number, y: number }>} active pointers */
    this._pointers = new Map();

    this._dragging = false;
    this._dragStart = null; // { x, y }
    this._pinchStartDist = 0;

    /** @type {Map<string, Set<Function>>} event -> handlers */
    this._handlers = new Map();

    /** @type {Array<{ target: EventTarget, type: string, fn: Function }>} */
    this._listeners = [];

    this.container = null;
  }

  /**
   * Attach pointer listeners to a container.
   * @param {HTMLElement} container
   */
  attach(container) {
    if (!container) {
      console.warn('[Gestures] No container provided');
      return;
    }
    this.container = container;

    this._addListener(container, 'pointerdown', this._onPointerDown.bind(this));
    // move/up on window so a drag that leaves the container still completes.
    this._addListener(window, 'pointermove', this._onPointerMove.bind(this));
    this._addListener(window, 'pointerup', this._onPointerUp.bind(this));
    this._addListener(window, 'pointercancel', this._onPointerUp.bind(this));
  }

  _addListener(target, type, fn) {
    target.addEventListener(type, fn);
    this._listeners.push({ target, type, fn });
  }

  // ==================== Pointer handling ====================

  _onPointerDown(e) {
    this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this._pointers.size === 1) {
      this._dragging = false;
      this._dragStart = { x: e.clientX, y: e.clientY };
    } else if (this._pointers.size === 2) {
      // Begin a potential pinch.
      this._pinchStartDist = this._currentPinchDistance();
      this._dragging = false;
      this._dragStart = null;
      this._emit('pinchstart', { scale: 1, distance: this._pinchStartDist });
    }
  }

  _onPointerMove(e) {
    const tracked = this._pointers.get(e.pointerId);
    if (!tracked) return;
    tracked.x = e.clientX;
    tracked.y = e.clientY;

    if (this._pointers.size >= 2) {
      // Pinch-zoom: report scale relative to the initial finger spread.
      const dist = this._currentPinchDistance();
      if (this._pinchStartDist > 0) {
        const scale = dist / this._pinchStartDist;
        this._emit('pinch', { scale, distance: dist });
      }
      return;
    }

    if (!this._dragStart) return;

    const dx = e.clientX - this._dragStart.x;
    const dy = e.clientY - this._dragStart.y;

    if (!this._dragging) {
      if (Math.hypot(dx, dy) >= this.dragThreshold) {
        this._dragging = true;
        this._emit('dragstart', {
          x: this._dragStart.x,
          y: this._dragStart.y,
          pointerId: e.pointerId,
        });
      } else {
        return;
      }
    }

    this._emit('drag', {
      x: e.clientX,
      y: e.clientY,
      dx,
      dy,
      pointerId: e.pointerId,
    });
  }

  _onPointerUp(e) {
    if (!this._pointers.has(e.pointerId)) return;

    const wasPinch = this._pointers.size >= 2;
    this._pointers.delete(e.pointerId);

    if (wasPinch) {
      this._emit('pinchend', {});
      this._pinchStartDist = 0;
      // If one pointer remains, re-arm single-pointer drag tracking from it.
      if (this._pointers.size === 1) {
        const [remaining] = this._pointers.values();
        this._dragStart = { x: remaining.x, y: remaining.y };
        this._dragging = false;
      }
      return;
    }

    if (this._dragging) {
      this._emit('dragend', {
        x: e.clientX,
        y: e.clientY,
        pointerId: e.pointerId,
      });
    }

    if (this._pointers.size === 0) {
      this._dragging = false;
      this._dragStart = null;
    }
  }

  _currentPinchDistance() {
    const pts = Array.from(this._pointers.values());
    if (pts.length < 2) return 0;
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }

  // ==================== Queries ====================

  /** @returns {boolean} true while an active drag gesture is in progress */
  get isDragging() {
    return this._dragging;
  }

  /** @returns {boolean} true while two pointers are down (pinching) */
  get isPinching() {
    return this._pointers.size >= 2;
  }

  // ==================== Events ====================

  /**
   * Subscribe to a gesture event:
   * 'dragstart' | 'drag' | 'dragend' | 'pinchstart' | 'pinch' | 'pinchend'.
   * Returns an unsubscribe function.
   * @param {string} type
   * @param {Function} fn
   */
  on(type, fn) {
    if (!this._handlers.has(type)) this._handlers.set(type, new Set());
    this._handlers.get(type).add(fn);
    return () => this._handlers.get(type)?.delete(fn);
  }

  _emit(type, payload) {
    const set = this._handlers.get(type);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(payload);
      } catch (e) {
        console.warn(`[Gestures] handler error for "${type}"`, e);
      }
    }
  }

  // ==================== Lifecycle ====================

  destroy() {
    this._listeners.forEach(({ target, type, fn }) => {
      target.removeEventListener(type, fn);
    });
    this._listeners = [];
    this._handlers.clear();
    this._pointers.clear();
    this._dragging = false;
    this._dragStart = null;
    this._pinchStartDist = 0;
    this.container = null;
  }
}
