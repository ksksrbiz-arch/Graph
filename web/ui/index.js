/**
 * Graph UI v2 — Public Entry Point
 *
 * High-effort, modern rebuild of the Personal Knowledge Graph interface.
 *
 * Usage:
 *   import { createGraphUI } from './web/ui/index.js';
 *   const ui = createGraphUI(document.getElementById('canvas'), { ... });
 */

import { GraphView } from './core/GraphView.js';
import { BrainSystem } from './brain/BrainSystem.js';
import { createGraph2DRenderer } from './renderers/Graph2DRenderer.js';
import { InteractionManager } from './interactions/InteractionManager.js';

export function createGraphUI(container, options = {}) {
  return new GraphView(container, options);
}

export {
  GraphView,
  BrainSystem,
  createGraph2DRenderer,
  InteractionManager,
};

console.log('%c[Graph UI v2] High-effort rebuild module loaded. Architecture foundation in progress.', 'color: #6ee7b7');
