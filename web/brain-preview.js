// Empty-state brain preview animation.
//
// When the graph has too little data to drive a meaningful "thinking"
// visualisation, we replace the static empty-state copy with a self-
// contained demo that loops through the same three phases the real graph
// uses — node birth → synapse growth → thinking ripple → fade — so the
// user can see exactly what their brain will look like once it has
// content.
//
// Self-hosting on a single canvas. No dependency on force-graph,
// state.js, or the brain-construction module — this loop is intentionally
// independent so it works even when the live renderer hasn't initialised
// (e.g. when the v1 deploy has no graph.json yet).

const REGION_PALETTE = [
  '#5dd2ff', // sensory
  '#9b8cff', // memory
  '#7c9cff', // association
  '#ff9b6b', // executive
  '#ff6b9d', // motor
  '#ffd45c', // limbic
];

// Coarse-pointer / small-viewport detection so the preview matches its
// host's tier. Re-checked on each phase boundary.
function isMobile() {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia?.('(pointer: coarse)').matches) return true;
  return Math.min(window.innerWidth || 9999, window.innerHeight || 9999) <= 820;
}

function reducedMotion() {
  return typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

const PHASE_DURATIONS = {
  birth: 2400,
  growth: 2400,
  thinking: 3200,
  fade: 1200,
};
const TOTAL_DURATION = PHASE_DURATIONS.birth
                     + PHASE_DURATIONS.growth
                     + PHASE_DURATIONS.thinking
                     + PHASE_DURATIONS.fade;

/**
 * Mount the preview animation into `host`. Returns a `{ stop }` handle so
 * the caller can tear it down before the next render. Idempotent — calling
 * twice on the same host replaces the previous instance.
 */
export function mountBrainPreview(host) {
  if (!host) return { stop() {} };

  // Tear down any previous instance.
  const prev = host.__preview;
  if (prev) try { prev.stop(); } catch {}

  host.innerHTML = '';
  host.classList.add('brain-preview-host');

  const wrapper = document.createElement('div');
  wrapper.className = 'brain-preview';
  const canvas = document.createElement('canvas');
  canvas.className = 'brain-preview-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  const caption = document.createElement('div');
  caption.className = 'brain-preview-caption';
  caption.innerHTML = `
    <div class="brain-preview-kicker">Neural Core • Preview</div>
    <h3>Your brain will look like this</h3>
    <p>
      Once you ingest some data, neurons will spawn for each concept, glowing
      synapses will form between related ideas, and thinking ripples will
      light up pathways as the cortex reasons over your graph.
    </p>
  `;
  wrapper.appendChild(canvas);
  wrapper.appendChild(caption);
  host.appendChild(wrapper);

  const ctx = canvas.getContext('2d');
  const mobile = isMobile();
  const reduced = reducedMotion();

  // Synthetic neuron layout. Placed in a rough oval so the preview reads
  // as a small brain rather than a random scatter. Coordinates are stored
  // in canvas units (0..1 normalised); we multiply by the canvas size each
  // frame so the layout reflows on resize.
  const layout = generateLayout(mobile ? 11 : 16);

  let raf = 0;
  let startMs = performance.now();
  let dpr = 1;
  let onResize = null;
  let stopped = false;
  let lastFrameMs = 0;

  const resize = () => {
    dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const w = wrapper.clientWidth || 480;
    // Cap height so the preview never dominates the viewport on mobile.
    const cssH = Math.min(280, Math.max(160, Math.round(w * 0.42)));
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${cssH}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  resize();
  onResize = () => resize();
  window.addEventListener('resize', onResize);

  // If the user prefers reduced motion, freeze on a final-state snapshot
  // and skip the rAF loop. The canvas still draws once so the placeholder
  // isn't blank.
  if (reduced) {
    drawSnapshotAtPhase('thinking', PHASE_DURATIONS.thinking * 0.6);
  } else {
    raf = requestAnimationFrame(tick);
  }

  function tick(now) {
    if (stopped) return;
    raf = requestAnimationFrame(tick);
    if (document.hidden) return;
    // Throttle to ~30fps on mobile.
    const minInterval = mobile ? 33 : 0;
    if (now - lastFrameMs < minInterval) return;
    lastFrameMs = now;

    const elapsed = (now - startMs) % TOTAL_DURATION;
    drawFrame(elapsed);
  }

  function drawFrame(elapsed) {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);

    // Backdrop halo so the preview matches the live #view-graph aesthetic.
    const bg = ctx.createRadialGradient(w * 0.5, h * 0.5, 0, w * 0.5, h * 0.5, Math.max(w, h) * 0.65);
    bg.addColorStop(0,   'rgba(124,156,255,0.16)');
    bg.addColorStop(0.6, 'rgba(124,156,255,0.04)');
    bg.addColorStop(1,   'rgba(0,0,0,0)');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // Determine current phase + local time within it.
    const phase = phaseAt(elapsed);
    const fadeAlpha = phase.name === 'fade'
      ? Math.max(0, 1 - phase.local / PHASE_DURATIONS.fade)
      : 1;

    // Always render any neurons that have already been "born" by this time.
    const bornCount = neuronBornCount(elapsed);

    // Render edges first so they sit behind neurons.
    drawEdges(elapsed, w, h, fadeAlpha);

    // Render thinking ripple particles.
    if (phase.name === 'thinking' || phase.name === 'fade') {
      drawThinking(elapsed, w, h, fadeAlpha);
    }

    // Render neurons + birth animation overlays.
    for (let i = 0; i < layout.nodes.length; i++) {
      const n = layout.nodes[i];
      const pos = nodePos(n, w, h);
      const bornAt = i * (PHASE_DURATIONS.birth / layout.nodes.length);
      if (elapsed >= bornAt) {
        drawNeuron(pos, n, elapsed - bornAt, fadeAlpha);
      }
    }

    // Status caption inside canvas — small label that names the current
    // phase so the preview reads as instructional rather than decorative.
    drawPhaseLabel(phase.name, w, h, fadeAlpha, bornCount);
  }

  function drawEdges(elapsed, w, h, alpha) {
    const growthStart = PHASE_DURATIONS.birth;
    const growthEnd = growthStart + PHASE_DURATIONS.growth;
    for (let i = 0; i < layout.edges.length; i++) {
      const e = layout.edges[i];
      const a = nodePos(layout.nodes[e.a], w, h);
      const b = nodePos(layout.nodes[e.b], w, h);
      const edgeBornAt = growthStart + (i / layout.edges.length) * PHASE_DURATIONS.growth * 0.85;
      if (elapsed < edgeBornAt) continue;

      const growthAge = Math.min(800, elapsed - edgeBornAt);
      const u = Math.min(1, growthAge / 800);
      const eased = 1 - Math.pow(1 - u, 3);
      const x1 = a.x + (b.x - a.x) * eased;
      const y1 = a.y + (b.y - a.y) * eased;

      // Settled edge (grey-blue) for fully grown.
      if (u >= 1 && elapsed >= growthEnd) {
        ctx.lineWidth = 1.0;
        ctx.strokeStyle = `rgba(160,170,190,${(0.30 * alpha).toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        continue;
      }

      // Growing tendril.
      ctx.lineCap = 'round';
      ctx.lineWidth = 2.4;
      ctx.strokeStyle = withAlpha(layout.nodes[e.a].color, 0.4 * alpha);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(x1, y1);
      ctx.stroke();
      ctx.lineWidth = 1.0;
      ctx.strokeStyle = `rgba(255,255,255,${(0.85 * (1 - u) * alpha).toFixed(3)})`;
      ctx.stroke();

      // Leading-edge spark.
      if (u < 0.95) {
        ctx.beginPath();
        ctx.arc(x1, y1, 1.6, 0, Math.PI * 2);
        ctx.fillStyle = withAlpha(layout.nodes[e.a].color, 0.85 * alpha);
        ctx.fill();
      }
    }
  }

  function drawNeuron(pos, n, age, alpha) {
    // Convergence + flash + halo, scaled down to fit the preview canvas.
    const u = Math.min(1, age / 1400);
    const r = 4 + Math.min(2, age / 600);

    if (u < 0.5) {
      // Particles spiraling in.
      const k = 1 - Math.min(1, u / 0.45);
      const eased = k * k;
      const PARTICLE_COUNT = 8;
      ctx.save();
      for (let i = 0; i < PARTICLE_COUNT; i++) {
        const ang = (i / PARTICLE_COUNT) * Math.PI * 2 + age * 0.003;
        const dist = 22 * eased;
        const px = pos.x + Math.cos(ang) * dist;
        const py = pos.y + Math.sin(ang) * dist;
        ctx.beginPath();
        ctx.arc(px, py, 1.2, 0, Math.PI * 2);
        ctx.fillStyle = withAlpha(n.color, 0.85 * (1 - k) * alpha);
        ctx.fill();
      }
      ctx.restore();
    }

    if (u >= 0.4 && u <= 0.7) {
      const k = (u - 0.4) / 0.3;
      const flashAlpha = (1 - k) * alpha;
      const flashR = 3 + k * 12;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, flashR, 0, Math.PI * 2);
      ctx.fillStyle = withAlpha('#ffffff', 0.6 * flashAlpha);
      ctx.fill();
    }

    // Settled neuron — always drawn after the converge phase.
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
    ctx.fillStyle = withAlpha(n.color, 0.92 * alpha);
    ctx.fill();
    // Soft outer glow.
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, r + 4, 0, Math.PI * 2);
    ctx.fillStyle = withAlpha(n.color, 0.18 * alpha);
    ctx.fill();
  }

  function drawThinking(elapsed, w, h, alpha) {
    // Send a wave of pulses along edges, BFS-style from a synthetic root.
    const tStart = PHASE_DURATIONS.birth + PHASE_DURATIONS.growth;
    const tLocal = elapsed - tStart;
    if (tLocal < 0) return;
    // Repeat the wave every 1.6s so the thinking phase has a heartbeat.
    const waveLocal = tLocal % 1600;
    const root = layout.thinkingRoot;
    const rootPos = nodePos(layout.nodes[root], w, h);

    // Expanding ring at the root.
    const ringU = Math.min(1, waveLocal / 1500);
    ctx.beginPath();
    ctx.arc(rootPos.x, rootPos.y, 4 + ringU * 38, 0, Math.PI * 2);
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = `rgba(255,138,61,${((1 - ringU) * 0.6 * alpha).toFixed(3)})`;
    ctx.stroke();

    // Edge pulses propagating outward.
    for (let i = 0; i < layout.bfs.length; i++) {
      const r = layout.bfs[i];
      const startMs = r.depth * 280;
      const localU = (waveLocal - startMs) / 700;
      if (localU < 0 || localU > 1) continue;
      const a = nodePos(layout.nodes[r.a], w, h);
      const b = nodePos(layout.nodes[r.b], w, h);
      const ex = a.x + (b.x - a.x) * localU;
      const ey = a.y + (b.y - a.y) * localU;
      const tailU = Math.max(0, localU - 0.25);
      const tx = a.x + (b.x - a.x) * tailU;
      const ty = a.y + (b.y - a.y) * tailU;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(ex, ey);
      ctx.lineWidth = 2.0;
      ctx.strokeStyle = `rgba(255,138,61,${(0.65 * (1 - localU) * alpha).toFixed(3)})`;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(ex, ey, 1.8, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,205,140,${(0.95 * (1 - localU) * alpha).toFixed(3)})`;
      ctx.fill();
    }
  }

  function drawPhaseLabel(name, w, h, alpha, bornCount) {
    const labels = {
      birth: `Spawning neurons · ${bornCount}/${layout.nodes.length}`,
      growth: 'Forming synapses…',
      thinking: 'Thinking — pathways activating',
      fade: '',
    };
    const text = labels[name] || '';
    if (!text) return;
    ctx.save();
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = `rgba(184,210,255,${(0.62 * alpha).toFixed(3)})`;
    ctx.fillText(text, 12, 10);
    ctx.restore();
  }

  function drawSnapshotAtPhase(phaseName, localMs) {
    let elapsed = 0;
    if (phaseName === 'birth') elapsed = localMs;
    else if (phaseName === 'growth') elapsed = PHASE_DURATIONS.birth + localMs;
    else if (phaseName === 'thinking') elapsed = PHASE_DURATIONS.birth + PHASE_DURATIONS.growth + localMs;
    drawFrame(elapsed);
  }

  function neuronBornCount(elapsed) {
    if (elapsed >= PHASE_DURATIONS.birth) return layout.nodes.length;
    return Math.min(layout.nodes.length, Math.floor((elapsed / PHASE_DURATIONS.birth) * layout.nodes.length));
  }

  function nodePos(n, w, h) {
    return { x: n.nx * w, y: n.ny * h };
  }

  const handle = {
    stop() {
      if (stopped) return;
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      if (onResize) window.removeEventListener('resize', onResize);
      onResize = null;
      try { wrapper.remove(); } catch {}
    },
  };
  host.__preview = handle;
  return handle;
}

function phaseAt(elapsed) {
  let t = elapsed;
  if (t < PHASE_DURATIONS.birth) return { name: 'birth', local: t };
  t -= PHASE_DURATIONS.birth;
  if (t < PHASE_DURATIONS.growth) return { name: 'growth', local: t };
  t -= PHASE_DURATIONS.growth;
  if (t < PHASE_DURATIONS.thinking) return { name: 'thinking', local: t };
  t -= PHASE_DURATIONS.thinking;
  return { name: 'fade', local: t };
}

function generateLayout(count) {
  // Spread points around a horizontally-stretched ellipse to suggest a
  // brain silhouette. Add a couple of "interior" nodes for cluster depth.
  const nodes = [];
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    const r = 0.34 + (i % 2) * 0.06;
    const nx = 0.5 + Math.cos(angle) * r;
    const ny = 0.5 + Math.sin(angle) * r * 0.55;
    nodes.push({
      nx,
      ny,
      color: REGION_PALETTE[i % REGION_PALETTE.length],
    });
  }
  // Two interior cluster nodes — pull edges into the centre for the
  // "thoughts converging" look.
  nodes.push({ nx: 0.45, ny: 0.5, color: REGION_PALETTE[2] });
  nodes.push({ nx: 0.56, ny: 0.5, color: REGION_PALETTE[1] });

  // Edges: a ring + a few diagonals + edges from each interior node to
  // ~4 ring nodes so there's a visible network when fully grown.
  const edges = [];
  for (let i = 0; i < count; i++) {
    edges.push({ a: i, b: (i + 1) % count });
    if (i % 3 === 0) edges.push({ a: i, b: (i + count / 2) % count | 0 });
  }
  const interiorA = nodes.length - 2;
  const interiorB = nodes.length - 1;
  for (let i = 0; i < count; i += 3) edges.push({ a: interiorA, b: i });
  for (let i = 1; i < count; i += 3) edges.push({ a: interiorB, b: i });
  edges.push({ a: interiorA, b: interiorB });

  // BFS layout for thinking ripple — start from interiorA.
  const root = interiorA;
  const adj = new Map();
  for (const e of edges) {
    if (!adj.has(e.a)) adj.set(e.a, []);
    if (!adj.has(e.b)) adj.set(e.b, []);
    adj.get(e.a).push(e.b);
    adj.get(e.b).push(e.a);
  }
  const visited = new Set([root]);
  let frontier = [root];
  const bfs = [];
  for (let depth = 0; depth < 4 && frontier.length; depth++) {
    const next = [];
    for (const id of frontier) {
      for (const nb of adj.get(id) || []) {
        if (visited.has(nb)) continue;
        visited.add(nb);
        bfs.push({ a: id, b: nb, depth });
        next.push(nb);
      }
    }
    frontier = next;
  }

  return { nodes, edges, bfs, thinkingRoot: root };
}

function withAlpha(color, a) {
  if (color.startsWith('rgba')) return color;
  if (color.startsWith('rgb')) {
    return color.replace('rgb(', 'rgba(').replace(')', `,${a})`);
  }
  const m = /^#?([0-9a-f]{6})$/i.exec(color);
  if (!m) return color;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
