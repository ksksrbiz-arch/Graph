// 2D renderer module. Wraps force-graph and exposes a uniform renderer API
// shared with graph-3d.js. The 2D path retains the original canvas-based
// look but now consumes every new config knob — opacity, curvature, edge
// width scale, color mode, regions, etc.

import { state } from '../state.js';
import { colorForType, srcId, tgtId, truncate } from '../util.js';
import { regionForNode, styleForRegion } from '../cortex.js';
import { createSpikeRenderer } from '../spike-render.js';
import { createBrainConstruction } from '../brain-construction.js';

export function create2DRenderer({ container, callbacks }) {
  container.innerHTML = '';
  const fg = ForceGraph()(container)
    .backgroundColor('rgba(0,0,0,0)')
    .autoPauseRedraw(false)
    .nodeId('id')
    .nodeLabel((n) => `${escapeLabel(n.label || n.id)} — ${n.type}`)
    .nodeVal((n) => Math.max(1, Math.sqrt(n.__degree || 1) * 3))
    .nodeRelSize(state.config.nodeRelSize)
    .linkColor((l) => edgeColor(l))
    .linkWidth((l) => 0.4 + (l.weight || 0.3) * (state.config.edgeWidthScale ?? 1.6))
    .linkCurvature((l) => (state.config.edgeCurvature || 0) * (1 - 1 / (1 + Math.abs(hashStr(linkKey(l))) % 7)))
    .onNodeHover((n) => {
      container.style.cursor = n ? 'pointer' : 'default';
      callbacks.onHover?.(n ? n.id : null);
    })
    .onNodeClick((n) => callbacks.onClick?.(n))
    .onNodeRightClick((n, evt) => callbacks.onRightClick?.(n, evt))
    .onBackgroundClick(() => callbacks.onBackgroundClick?.())
    .onBackgroundRightClick((evt) => callbacks.onBackgroundRightClick?.(evt))
    .nodeCanvasObjectMode(() => 'after')
    .nodeCanvasObject(drawNode);

  const ro = new ResizeObserver(() => {
    fg.width(container.clientWidth).height(container.clientHeight);
  });
  ro.observe(container);
  fg.width(container.clientWidth).height(container.clientHeight);

  const spikes = createSpikeRenderer(fg, state);
  const construction = createBrainConstruction(fg, state);

  function drawNode(node, ctx, scale) {
    const r = nodeRadius(node);
    const dim = isDimmed(node);
    const c = nodeColor(node);
    const baseAlpha = state.config.nodeOpacity ?? 1;
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
    ctx.fillStyle = dim ? withAlpha(c, 0.18 * baseAlpha) : withAlpha(c, baseAlpha);
    ctx.fill();
    if (state.selectedId === node.id || state.focusRootId === node.id) {
      ctx.lineWidth = 2 / scale;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
    } else if (state.hoveredId === node.id) {
      ctx.lineWidth = 1.5 / scale;
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.stroke();
    }
    const isFocal =
      node.id === state.selectedId ||
      node.id === state.hoveredId ||
      node.id === state.focusRootId;
    const focalAnchor = state.hoveredId || state.selectedId;
    const isFocalNeighbor = focalAnchor && focalAnchor !== node.id &&
      state.adjacency.get(focalAnchor)?.has(node.id);

    let drawLabel = false;
    if (isFocal || isFocalNeighbor) drawLabel = true;
    else if (state.config.showLabels) {
      const isHub = (node.__degree || 0) >= 4;
      if (isHub || scale >= 1.5) drawLabel = true;
    }
    if (!drawLabel) return;

    const label = node.label || node.id;
    const fontSize = Math.max(10, 12 / scale);
    ctx.font = `${fontSize}px -apple-system, system-ui, sans-serif`;
    const textX = node.x + r + 4;
    const textY = node.y;
    if (isFocal) {
      ctx.font = `600 ${fontSize}px -apple-system, system-ui, sans-serif`;
      const text = truncate(label, 40);
      const padX = 4 / scale;
      const padY = 2 / scale;
      const w = ctx.measureText(text).width;
      ctx.fillStyle = 'rgba(11,13,18,0.78)';
      ctx.fillRect(textX - padX, textY - fontSize / 2 - padY, w + padX * 2, fontSize + padY * 2);
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, textX, textY);
    } else {
      ctx.fillStyle = dim ? 'rgba(230,232,238,0.35)' : '#e6e8ee';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(truncate(label, 40), textX, textY);
    }
  }

  function nodeRadius(n) {
    const deg = n.__degree || 1;
    const base = state.config.nodeRelSize ?? 4;
    return Math.max(2, Math.min(24, base + Math.sqrt(deg) * 2));
  }

  function isDimmed(node) {
    if (!state.hoveredId) return false;
    if (state.hoveredId === node.id) return false;
    const nbrs = state.adjacency.get(state.hoveredId);
    return !(nbrs && nbrs.has(node.id));
  }

  function edgeColor(link) {
    const baseAlpha = state.config.edgeOpacity ?? 0.35;
    if (state.hoveredId) {
      const s = srcId(link), t = tgtId(link);
      if (s === state.hoveredId || t === state.hoveredId) {
        return `rgba(124,156,255,${Math.min(0.95, baseAlpha + 0.45)})`;
      }
      return `rgba(160,170,190,${baseAlpha * 0.2})`;
    }
    return `rgba(160,170,190,${baseAlpha})`;
  }

  function nodeColor(n) {
    const mode = state.config.colorMode || 'type';
    if (mode === 'region') return styleForRegion(n.region || regionForNode(n)).color;
    if (mode === 'degree') return degreeColor(n.__degree || 0);
    return colorForType(n.type);
  }

  function applyConfig() {
    const charge = fg.d3Force('charge');
    if (charge) charge.strength(state.config.chargeStrength);
    const link = fg.d3Force('link');
    if (link) {
      link.distance(state.config.linkDistance);
      if (typeof link.strength === 'function') link.strength(state.config.linkStrength);
    }
    const center = fg.d3Force('center');
    if (center && typeof center.strength === 'function') {
      center.strength(state.config.gravity * 4);
    }
    fg.nodeRelSize(state.config.nodeRelSize);
    if (typeof fg.d3VelocityDecay === 'function') fg.d3VelocityDecay(state.config.velocityDecay);
    if (typeof fg.d3AlphaDecay === 'function') fg.d3AlphaDecay(state.config.alphaDecay);
    if (typeof fg.cooldownTicks === 'function' && Number.isFinite(state.config.cooldownTicks)) {
      fg.cooldownTicks(state.config.cooldownTicks);
    }
    fg.d3ReheatSimulation();
  }

  return {
    kind: '2d',
    fg,
    setData(graph) {
      fg.graphData(graph);
      // Diff against the previous sync and queue construction animations
      // for any node/edge that just appeared.
      construction.syncFromGraph();
    },
    applyConfig,
    refresh() { fg.refresh?.(); },
    fit(ms = 500, pad = 60) { fg.zoomToFit(ms, pad); },
    zoomIn() { fg.zoom(fg.zoom() * 1.4, 250); },
    zoomOut() { fg.zoom(fg.zoom() / 1.4, 250); },
    centerOn(node, ms = 600) {
      if (node.x != null && node.y != null) {
        fg.centerAt(node.x, node.y, ms);
        fg.zoom(Math.max(fg.zoom(), 2.5), ms);
      }
    },
    screen2GraphCoords(x, y) { return fg.screen2GraphCoords(x, y); },
    spikeNode(neuronId) { spikes.onSpike(neuronId); },
    startSpikes() { spikes.start(); construction.start(); },
    stopSpikes() { spikes.stop(); spikes.clear(); construction.stop(); construction.clear(); },
    bornNode(neuronId) { construction.spawnBirth(neuronId); },
    grewEdge(edge) { construction.spawnGrowth(edge); },
    thinkWave(rootId, color) { construction.spawnThinkWave(rootId, color); },
    destroy() {
      try { spikes.stop(); } catch {}
      try { construction.stop(); } catch {}
      try { ro.disconnect(); } catch {}
      try { fg._destructor?.(); } catch {}
      container.innerHTML = '';
    },
  };
}

function escapeLabel(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
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

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}

function linkKey(l) {
  return `${srcId(l)}::${tgtId(l)}`;
}

const HEAT = ['#3a4663', '#4a6fa5', '#5dd2ff', '#9b8cff', '#ff9b6b', '#ff6b9d'];
function degreeColor(d) {
  const i = Math.min(HEAT.length - 1, Math.floor(Math.log2(d + 1)));
  return HEAT[i];
}
