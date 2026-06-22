/**
 * Effects registry — central catalogue of modular brain visual effects.
 *
 * Every effect module exposes a uniform factory:
 *   create(params) -> { type, step(dt, ctx), done(), ...meta }
 *
 * The AnimationOrchestrator looks effects up by name here, so adding a new
 * effect is a two-line change: write the module, register it below.
 */

import { create as createSpawnPulse } from './SpawnPulse.js';
import { create as createQueryTrace } from './QueryTrace.js';
import { create as createInferenceArc } from './InferenceArc.js';

/** @type {Record<string, (params?: object) => object>} */
export const EFFECTS = {
  'spawn-pulse': createSpawnPulse,
  'query-trace': createQueryTrace,
  'inference-arc': createInferenceArc,
};

/**
 * Instantiate an effect by registered name.
 * @param {string} name   One of the keys in EFFECTS.
 * @param {object} params Effect-specific parameters.
 * @returns {object} effect instance with step()/done().
 */
export function createEffect(name, params = {}) {
  const factory = EFFECTS[name];
  if (!factory) {
    throw new Error(`[Effects] Unknown effect "${name}". Known: ${Object.keys(EFFECTS).join(', ')}`);
  }
  return factory(params);
}

/** @returns {string[]} names of all registered effects. */
export function listEffects() {
  return Object.keys(EFFECTS);
}

export {
  createSpawnPulse,
  createQueryTrace,
  createInferenceArc,
};
