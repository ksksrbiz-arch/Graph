/**
 * Graph2DRenderer v2 — High Quality 2D Implementation
 * 
 * Designed to work beautifully with the new BrainSystem.
 * Uses the force-graph library for physics but takes full control of drawing
 * for advanced neural/brain visual effects.
 */

export function createGraph2DRenderer(container, options = {}) {
  if (typeof window.ForceGraph !== 'function') {
    container.innerHTML = `<div style="color:#f66;padding:2rem">force-graph library not available</div>`;
    return null;
  }

  container.innerHTML = '';

  const fg = ForceGraph()(container)
    .backgroundColor('transparent')
    .autoPauseRedraw(false) // We want full control for brain effects
    .nodeId('id')
    .nodeVal(n => Math.max(2, Math.sqrt(n.__degree || 1) * 3.8))
    .nodeRelSize(5)
    .linkColor(() => 'rgba(130, 150, 255, 0.22)')
    .linkWidth(l => 0.7 + (l.weight || 0.3) * 2.8)
    .linkCurvature(0.12);

  // We will override the node drawing for brain effects
  fg.nodeCanvasObjectMode(() => 'replace');
  fg.nodeCanvasObject((node, ctx, globalScale) => {
    const r = (node.__size || 4) * (node.__brainScale || 1);
    const alpha = node.__brainAlpha ?? 0.95;

    ctx.save();
    ctx.globalAlpha = alpha;

    // Base node
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
    ctx.fillStyle = node.__color || '#7aa2f7';
    ctx.fill();

    // Brain glow / heat ring
    if (node.__heat > 0.05) {
      const heat = node.__heat;
      ctx.beginPath();
      ctx.arc(node.x, node.y, r * (1 + heat * 0.6), 0, Math.PI * 2);
      ctx.fillStyle = `rgba(165, 180, 252, ${heat * 0.35})`;
      ctx.fill();
    }

    // Selection / Focus ring
    if (node.__selected || node.__focused) {
      ctx.strokeStyle = node.__focused ? '#a5f3fc' : '#ffffff';
      ctx.lineWidth = (node.__focused ? 3.5 : 2) / globalScale;
      ctx.beginPath();
      ctx.arc(node.x, node.y, r + 2.5, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
  });

  // Link drawing with subtle brain influence
  fg.linkCanvasObject((link, ctx, globalScale) => {
    const start = link.source;
    const end = link.target;
    if (!start || !end) return;

    const brainFlow = (start.__heat || 0) * 0.4 + (end.__heat || 0) * 0.4;
    ctx.strokeStyle = brainFlow > 0.1 
      ? `rgba(160, 200, 255, ${0.35 + brainFlow * 0.4})`
      : 'rgba(130, 150, 255, 0.28)';
    ctx.lineWidth = (0.8 + (link.weight || 0.3) * 2.5) / globalScale;
  });

  const resizeObserver = new ResizeObserver(() => {
    fg.width(container.clientWidth);
    fg.height(container.clientHeight);
  });
  resizeObserver.observe(container);
  fg.width(container.clientWidth).height(container.clientHeight);

  return {
    setData(graphData) {
      fg.graphData(graphData);
    },
    updateNodeVisual(nodeId, visualProps) {
      // This will be called by the BrainSystem integration layer
      const node = fg.graphData().nodes.find(n => n.id === nodeId);
      if (node) {
        Object.assign(node, visualProps);
      }
    },
    fit(duration = 500, padding = 80) {
      fg.zoomToFit(duration, padding);
    },
    zoomIn(factor = 1.35) { fg.zoom(factor, 280); },
    zoomOut(factor = 1.35) { fg.zoom(1 / factor, 280); },
    destroy() {
      resizeObserver.disconnect();
      // force-graph doesn't have a clean public destroy, but we can clear
      container.innerHTML = '';
    },
    _fg: fg, // escape hatch
  };
}
