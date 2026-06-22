/**
 * Focus — Ego-focus ("zoom into a node's neighborhood") state for Graph UI v2.
 *
 * Focus mode pins the view onto a single root node and a depth radius around
 * it (its "ego network"). This module owns only the focus *state* — which node
 * is the focus root and how deep the neighborhood reaches — plus a helper to
 * compute the focused id set from an adjacency map. Reflecting that state into
 * the StateManager / renderer is the InteractionManager's job.
 *
 * Mirrors StateManager's focusRootId / focusDepth slices (see
 * core/StateManager.js).
 */

export class Focus {
  constructor({ defaultDepth = 2 } = {}) {
    /** Currently focused root node id, or null when not focused. */
    this._rootId = null;

    /** Neighborhood depth (hops) when entering focus. */
    this._depth = defaultDepth;

    this._defaultDepth = defaultDepth;

    /** @type {Set<(snapshot: { rootId: string|null, depth: number }) => void>} */
    this._listeners = new Set();
  }

  // ==================== Queries ====================

  /** @returns {boolean} */
  get isActive() {
    return this._rootId != null;
  }

  /** @returns {string|null} */
  get rootId() {
    return this._rootId;
  }

  /** @returns {number} */
  get depth() {
    return this._depth;
  }

  // ==================== Mutations ====================

  /**
   * Enter focus on a node.
   * @param {string} rootId
   * @param {number} [depth] hops; defaults to the current/configured depth
   * @returns {boolean} true if the focus state changed
   */
  enter(rootId, depth = this._depth) {
    if (rootId == null) return false;
    const nextDepth = Math.max(0, Math.floor(depth));
    if (this._rootId === rootId && this._depth === nextDepth) return false;
    this._rootId = rootId;
    this._depth = nextDepth;
    this._notify();
    return true;
  }

  /**
   * Exit focus mode, restoring the default depth.
   * @returns {boolean} true if focus was active
   */
  exit() {
    if (this._rootId == null) return false;
    this._rootId = null;
    this._depth = this._defaultDepth;
    this._notify();
    return true;
  }

  /**
   * Toggle focus for a node: enter if not focused on it, otherwise exit.
   * @param {string} rootId
   * @param {number} [depth]
   * @returns {boolean} true if focus is active on rootId after the call
   */
  toggle(rootId, depth = this._depth) {
    if (this._rootId === rootId) {
      this.exit();
      return false;
    }
    this.enter(rootId, depth);
    return true;
  }

  /**
   * Set the depth without changing the focused root.
   * @param {number} depth
   * @returns {boolean} true if depth changed
   */
  setDepth(depth) {
    const next = Math.max(0, Math.floor(depth));
    if (next === this._depth) return false;
    this._depth = next;
    this._notify();
    return true;
  }

  // ==================== Neighborhood computation ====================

  /**
   * Compute the set of node ids within the current focus neighborhood using a
   * breadth-first walk over an adjacency map (nodeId -> Set<neighborId>), as
   * produced by StateManager.setGraph().
   *
   * Returns an empty set when focus is inactive.
   *
   * @param {Map<string, Set<string>>} adjacency
   * @param {string} [rootId] override root (defaults to current focus root)
   * @param {number} [depth] override depth (defaults to current focus depth)
   * @returns {Set<string>}
   */
  computeNeighborhood(adjacency, rootId = this._rootId, depth = this._depth) {
    const result = new Set();
    if (rootId == null || !adjacency) return result;

    result.add(rootId);
    let frontier = [rootId];

    for (let hop = 0; hop < depth; hop++) {
      const next = [];
      for (const id of frontier) {
        const neighbors = adjacency.get(id);
        if (!neighbors) continue;
        for (const nb of neighbors) {
          if (!result.has(nb)) {
            result.add(nb);
            next.push(nb);
          }
        }
      }
      if (next.length === 0) break;
      frontier = next;
    }

    return result;
  }

  // ==================== Subscriptions ====================

  /**
   * Subscribe to focus changes. Returns an unsubscribe function.
   * @param {(snapshot: { rootId: string|null, depth: number }) => void} fn
   */
  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _notify() {
    const snapshot = { rootId: this._rootId, depth: this._depth };
    for (const fn of this._listeners) {
      try {
        fn(snapshot);
      } catch (e) {
        console.warn('[Focus] listener error', e);
      }
    }
  }
}
