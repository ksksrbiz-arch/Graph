/**
 * InferenceArc — a directed reasoning arc connecting two nodes when the cortex
 * draws an inference between them.
 *
 * Modeled on BrainSystem._spawnInferenceArc: a single travelling particle from
 * `from` to `to`, carrying the inference `reason`. Here it is a self-contained
 * effect with a short head-travel phase followed by a fading "settled" glow on
 * the established link.
 *
 * Uniform effect interface: create(params), step(dt, ctx), done().
 * Descriptive only — emits arc descriptors via ctx.emit(...).
 */

const DEFAULTS = {
  from: null,
  to: null,
  reason: '',
  travelDuration: 900, // ms for the head to traverse the arc
  glowDuration: 700,   // ms the arc lingers/fades after arrival
  color: '#67e8f9',
};

/**
 * @param {object} params
 * @param {string} params.from           Source nodeId.
 * @param {string} params.to             Target nodeId.
 * @param {string} [params.reason]       Human-readable inference reason.
 * @param {number} [params.travelDuration]
 * @param {number} [params.glowDuration]
 * @param {string} [params.color]
 */
export function create(params = {}) {
  const cfg = { ...DEFAULTS, ...params };

  let travel = 0; // 0..1 head position
  let glow = 0;   // 0..1 fade-out after arrival
  // Degenerate arcs (missing/identical endpoints) have nothing to draw and
  // should be reaped immediately rather than linger as no-op effects.
  const degenerate = cfg.from == null || cfg.to == null || cfg.from === cfg.to;

  return {
    type: 'inference-arc',
    from: cfg.from,
    to: cfg.to,
    reason: cfg.reason,

    step(dt, ctx) {
      if (degenerate) return;

      if (travel < 1) {
        travel = Math.min(1, travel + dt / cfg.travelDuration);
      } else if (glow < 1) {
        glow = Math.min(1, glow + dt / cfg.glowDuration);
      }

      ctx.emit({
        type: 'inference-arc',
        fromNodeId: cfg.from,
        toNodeId: cfg.to,
        progress: travel,                 // head position along the arc
        settled: travel >= 1,
        size: 2,
        color: cfg.color,
        // bright while travelling, then fade as the glow phase advances
        opacity: travel < 1 ? 0.85 : 0.85 * (1 - glow),
        reason: cfg.reason,
      });
    },

    done() {
      return degenerate || (travel >= 1 && glow >= 1);
    },
  };
}
