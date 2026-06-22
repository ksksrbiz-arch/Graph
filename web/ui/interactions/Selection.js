/**
 * Selection — Multi-select state for the Graph UI v2 interaction layer.
 *
 * A small, dependency-free helper that owns the set of currently selected
 * node ids and implements the common selection semantics used by the
 * InteractionManager:
 *
 * - add / remove / toggle individual ids
 * - clear all
 * - Shift / Cmd "additive" click semantics via {@link Selection#applyClick}
 *
 * The module is intentionally renderer- and state-agnostic. It just tracks
 * which ids are selected and notifies subscribers when that set changes; the
 * InteractionManager is responsible for reflecting the result into the
 * StateManager and the renderer.
 */

export class Selection {
  constructor() {
    /** @type {Set<string>} */
    this._ids = new Set();

    /** Most recently selected id (the "primary" / anchor selection). */
    this._primaryId = null;

    /** @type {Set<(snapshot: { ids: string[], primaryId: string|null }) => void>} */
    this._listeners = new Set();
  }

  // ==================== Queries ====================

  /** @returns {boolean} */
  has(id) {
    return this._ids.has(id);
  }

  /** @returns {number} */
  get size() {
    return this._ids.size;
  }

  /** @returns {boolean} */
  get isEmpty() {
    return this._ids.size === 0;
  }

  /** The anchor / most-recently-selected id, or null. */
  get primaryId() {
    return this._primaryId;
  }

  /** @returns {string[]} a fresh array snapshot of selected ids */
  toArray() {
    return Array.from(this._ids);
  }

  // ==================== Mutations ====================

  /**
   * Add an id to the selection. Becomes the new primary id.
   * @returns {boolean} true if membership changed (a new id was added)
   */
  add(id) {
    if (id == null) return false;
    const had = this._ids.has(id);
    const primaryChanged = this._primaryId !== id;
    this._ids.add(id);
    this._primaryId = id;
    if (!had || primaryChanged) this._notify();
    return !had;
  }

  /**
   * Remove an id from the selection.
   * @returns {boolean} true if the selection changed
   */
  remove(id) {
    if (!this._ids.delete(id)) return false;
    if (this._primaryId === id) {
      // Fall back to the most-recently-inserted remaining id, or null.
      this._primaryId = this._ids.size ? this._lastInsertedId() : null;
    }
    this._notify();
    return true;
  }

  /**
   * Toggle an id's membership.
   * @returns {boolean} true if the id is selected after toggling
   */
  toggle(id) {
    if (id == null) return false;
    if (this._ids.has(id)) {
      this.remove(id);
      return false;
    }
    this.add(id);
    return true;
  }

  /**
   * Replace the entire selection with a single id (the typical single-click
   * behavior). Pass null to clear.
   * @returns {boolean} true if the selection changed
   */
  set(id) {
    const onlyThis =
      this._ids.size === 1 && this._ids.has(id) && this._primaryId === id;
    if (onlyThis) return false;
    if (id == null) return this.clear();
    this._ids.clear();
    this._ids.add(id);
    this._primaryId = id;
    this._notify();
    return true;
  }

  /** Clear all selected ids. @returns {boolean} true if anything was cleared */
  clear() {
    if (this._ids.size === 0 && this._primaryId == null) return false;
    this._ids.clear();
    this._primaryId = null;
    this._notify();
    return true;
  }

  // ==================== Click semantics ====================

  /**
   * Apply click semantics given a node id and the originating event.
   *
   * - Shift / Cmd (meta) / Ctrl click → toggle the id (additive multi-select).
   * - Plain click → replace selection with just this id.
   *
   * @param {string} id
   * @param {{ shiftKey?: boolean, metaKey?: boolean, ctrlKey?: boolean }} [event]
   * @returns {{ ids: string[], primaryId: string|null, multi: boolean }}
   */
  applyClick(id, event = {}) {
    const multi = !!(event.shiftKey || event.metaKey || event.ctrlKey);
    if (multi) {
      this.toggle(id);
    } else {
      this.set(id);
    }
    return { ids: this.toArray(), primaryId: this._primaryId, multi };
  }

  // ==================== Subscriptions ====================

  /**
   * Subscribe to selection changes. Returns an unsubscribe function.
   * @param {(snapshot: { ids: string[], primaryId: string|null }) => void} fn
   */
  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _notify() {
    const snapshot = { ids: this.toArray(), primaryId: this._primaryId };
    for (const fn of this._listeners) {
      try {
        fn(snapshot);
      } catch (e) {
        console.warn('[Selection] listener error', e);
      }
    }
  }

  /** Best-effort "last inserted" id (Set preserves insertion order). */
  _lastInsertedId() {
    let last = null;
    for (const id of this._ids) last = id;
    return last;
  }
}
