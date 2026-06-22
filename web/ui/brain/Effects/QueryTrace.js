/**
 * QueryTrace — a directed "search / recall" trace that travels from a query
 * origin across a chain of nodes, lighting each hop in turn.
 *
 * Modeled on BrainSystem's spike + ambient particle motion (progress-driven
 * travel between two endpoints), generalized into a multi-hop path so a query
 * can visibly ripple along the nodes it touches.
 *
 * Uniform effect interface: create(params), step(dt, ctx), done().
 * Descriptive only — emits travelling-particle descriptors via ctx.emit(...).
 */

const DEFAULTS = {
  path: [],        // ordered list of nodeIds the trace visits
  intensity: 0.8,
  hopDuration: 320, // ms per hop
  color: '#a5b4fc',
};

/**
 * @param {object} params
 * @param {string[]} params.path        Ordered nodeIds (>= 2) to trace through.
 * @param {number} [params.intensity]   0..1 strength.
 * @param {number} [params.hopDuration] ms to travel a single hop.
 * @param {string} [params.color]
 */
export function create(params = {}) {
  const cfg = { ...DEFAULTS, ...params };
  const path = Array.isArray(cfg.path) ? cfg.path.filter((id) => id != null) : [];
  const intensity = clamp01(cfg.intensity);
  const hopCount = Math.max(0, path.length - 1);

  let hop = 0;            // current segment index
  let hopProgress = 0;    // 0..1 within the current segment

  return {
    type: 'query-trace',
    path,

    step(dt, ctx) {
      if (hopCount === 0) return; // nothing to trace (degenerate path)

      hopProgress += dt / cfg.hopDuration;
      while (hopProgress >= 1 && hop < hopCount) {
        hopProgress -= 1;
        hop += 1;
      }
      if (hop >= hopCount) return; // finished travelling

      const fromId = path[hop];
      const toId = path[hop + 1];

      ctx.emit({
        type: 'query-trace',
        fromNodeId: fromId,
        toNodeId: toId,
        progress: clamp01(hopProgress),
        size: 1.5 + intensity * 1.8,
        color: cfg.color,
        opacity: 0.5 + intensity * 0.45,
        // overall fraction of the whole path, handy for trailing fades
        pathProgress: (hop + clamp01(hopProgress)) / hopCount,
      });
    },

    done() {
      return hopCount === 0 || hop >= hopCount;
    },
  };
}

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}
