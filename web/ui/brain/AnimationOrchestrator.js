/**
 * AnimationOrchestrator — sequences and schedules modular brain visual effects.
 *
 * Decoupled from BrainSystem: BrainSystem owns neural *state* (activation,
 * modes, attention); the orchestrator owns the transient *visual choreography*
 * (spawn pulses, query traces, inference arcs). A coordinator wires the two
 * together later — e.g. forwarding BrainSystem events into orchestrator.trigger().
 *
 * Design mirrors BrainSystem's conventions:
 *   - self-driven requestAnimationFrame loop with a capped delta
 *   - subscribe(fn) / getSnapshot() reactive surface
 *   - emit/publish to subscribers each frame
 *
 * Effects come from ./Effects (uniform create/step/done interface). Each frame
 * the orchestrator steps every live effect, collecting the particle-like
 * descriptors they emit, then publishes the frame's descriptor list to
 * subscribers (renderers/HUD). Effects that report done() are reaped.
 */

import { createEffect, listEffects } from './Effects/index.js';

export class AnimationOrchestrator {
  /**
   * @param {object} [options]
   * @param {number} [options.maxEffects]   Soft cap on concurrent effects.
   * @param {number} [options.maxDelta]     ms delta cap per frame.
   * @param {boolean} [options.autoStart]   Start the rAF loop immediately.
   */
  constructor(options = {}) {
    this.options = {
      maxEffects: 240,
      maxDelta: 50,
      autoStart: true,
      ...options,
    };

    this.effects = [];      // live effect instances
    this.scheduled = [];    // { delay, name, params } pending timers
    this.frame = [];        // descriptors emitted during the most recent frame

    this.subscribers = new Set();

    this._raf = null;
    this._lastTime = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this._isRunning = false;

    // ctx passed to every effect.step(); stable identity, mutated per frame.
    this._ctx = {
      emit: (descriptor) => this.frame.push(descriptor),
      orchestrator: this,
    };

    if (this.options.autoStart) this.start();
  }

  // ==================== PUBLIC API ====================

  /** Subscribe to per-frame descriptor batches. Returns an unsubscribe fn. */
  subscribe(fn) {
    this.subscribers.add(fn);
    fn(this.getSnapshot());
    return () => this.subscribers.delete(fn);
  }

  getSnapshot() {
    return {
      effects: this.effects.length,
      scheduled: this.scheduled.length,
      descriptors: [...this.frame],
    };
  }

  /** Names of effects this orchestrator knows how to instantiate. */
  available() {
    return listEffects();
  }

  /**
   * Trigger an effect immediately by registered name.
   * @param {string} name   Registered effect name (see ./Effects).
   * @param {object} params Effect-specific params.
   * @returns {object|null} the created effect instance, or null if at capacity.
   */
  trigger(name, params = {}) {
    if (this.effects.length >= this.options.maxEffects) {
      // Drop the oldest effect to make room rather than unbounded growth.
      this.effects.shift();
    }
    let effect;
    try {
      effect = createEffect(name, params);
    } catch (e) {
      console.warn('[AnimationOrchestrator] trigger failed:', e);
      return null;
    }
    this.effects.push(effect);
    return effect;
  }

  /**
   * Schedule an effect to fire after `delay` ms (driven by the rAF clock, not
   * a wall-clock timer, so it pauses cleanly when the loop is stopped).
   * @returns {object} a handle with cancel().
   */
  schedule(name, params = {}, delay = 0) {
    const item = { remaining: Math.max(0, delay), name, params, cancelled: false };
    this.scheduled.push(item);
    return { cancel: () => { item.cancelled = true; } };
  }

  /**
   * Convenience: trigger a staggered sequence of effects.
   * @param {Array<{name:string, params?:object, at?:number}>} steps
   *   `at` is ms offset from now (defaults to cumulative `gap`).
   * @param {number} [gap] default spacing when `at` is omitted.
   */
  sequence(steps = [], gap = 250) {
    let cursor = 0;
    const handles = [];
    for (const s of steps) {
      const at = typeof s.at === 'number' ? s.at : cursor;
      handles.push(this.schedule(s.name, s.params || {}, at));
      cursor = at + gap;
    }
    return handles;
  }

  /** Remove all live + scheduled effects without stopping the loop. */
  clear() {
    this.effects = [];
    this.scheduled = [];
    this.frame = [];
  }

  start() {
    if (this._isRunning) return;
    this._isRunning = true;
    this._lastTime = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const loop = (now) => {
      if (!this._isRunning) return;
      const dt = Math.min(now - this._lastTime, this.options.maxDelta);
      this._lastTime = now;
      this._tick(dt);
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    this._isRunning = false;
    if (this._raf != null) {
      cancelAnimationFrame(this._raf);
      this._raf = null;
    }
  }

  destroy() {
    this.stop();
    this.subscribers.clear();
    this.clear();
  }

  // ==================== INTERNAL ====================

  _tick(dt) {
    // 1) advance scheduled effects; fire any that are due.
    if (this.scheduled.length) {
      const stillPending = [];
      for (const item of this.scheduled) {
        if (item.cancelled) continue;
        item.remaining -= dt;
        if (item.remaining <= 0) {
          this.trigger(item.name, item.params);
        } else {
          stillPending.push(item);
        }
      }
      this.scheduled = stillPending;
    }

    // 2) step every live effect, collecting this frame's descriptors.
    this.frame = [];
    const survivors = [];
    for (const effect of this.effects) {
      try {
        effect.step(dt, this._ctx);
      } catch (e) {
        console.warn('[AnimationOrchestrator] effect.step error:', e);
        continue; // drop a misbehaving effect
      }
      let finished = false;
      try {
        finished = effect.done();
      } catch (e) {
        console.warn('[AnimationOrchestrator] effect.done error:', e);
        finished = true; // reap effects that throw on done()
      }
      if (!finished) survivors.push(effect);
    }
    this.effects = survivors;

    // 3) publish the frame.
    this._publish();
  }

  _publish() {
    const snap = this.getSnapshot();
    for (const fn of this.subscribers) {
      try {
        fn(snap);
      } catch (e) {
        console.warn('[AnimationOrchestrator] subscriber error:', e);
      }
    }
  }
}

export default AnimationOrchestrator;
