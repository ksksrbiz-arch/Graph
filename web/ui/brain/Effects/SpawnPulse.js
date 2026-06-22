/**
 * SpawnPulse — an expanding "perception" pulse emitted when new nodes arrive.
 *
 * Modeled on BrainSystem's spawn-activity + attention-ripple inline logic, but
 * extracted into a self-contained, orchestrator-driven effect.
 *
 * Uniform effect interface:
 *   create(params)  -> returns an effect instance (this module's factory)
 *   step(dt, ctx)   -> advance by dt ms; ctx carries shared services/registry
 *   done()          -> true once the effect has finished and can be reaped
 *
 * The effect is purely descriptive: it produces transient particle-like
 * descriptors via ctx.emit(...) so any renderer can draw them. It never
 * touches BrainSystem directly.
 */

const DEFAULTS = {
  nodeId: null,
  intensity: 0.9,
  rings: 3,
  duration: 1100, // ms for a single ring to fully expand
  baseColor: 220, // hue
};

/**
 * @param {object} params
 * @param {string} params.nodeId      Node the pulse radiates from.
 * @param {number} [params.intensity] 0..1 strength.
 * @param {number} [params.rings]     Number of concentric rings.
 * @param {number} [params.duration]  Lifetime of each ring in ms.
 */
export function create(params = {}) {
  const cfg = { ...DEFAULTS, ...params };
  const intensity = clamp01(cfg.intensity);

  // Each ring is staggered so they ripple outward in sequence.
  const rings = [];
  for (let i = 0; i < cfg.rings; i++) {
    rings.push({
      // negative progress => initial delay before the ring becomes visible
      progress: -i * 0.18,
      duration: cfg.duration + i * 60,
    });
  }

  return {
    type: 'spawn-pulse',
    nodeId: cfg.nodeId,

    step(dt, ctx) {
      for (const ring of rings) {
        ring.progress += dt / ring.duration;
        if (ring.progress < 0 || ring.progress > 1) continue;

        const eased = easeOutCubic(ring.progress);
        ctx.emit({
          type: 'spawn-pulse',
          fromNodeId: cfg.nodeId,
          radiusScale: eased,            // 0..1, renderer maps to pixels
          size: 2 + intensity * 3,
          color: `hsl(${cfg.baseColor}, 90%, ${78 + intensity * 12}%)`,
          opacity: (1 - ring.progress) * (0.55 + intensity * 0.35),
        });
      }
    },

    done() {
      return rings.every((r) => r.progress >= 1);
    },
  };
}

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

function easeOutCubic(t) {
  const c = Math.max(0, Math.min(1, t));
  return 1 - Math.pow(1 - c, 3);
}
