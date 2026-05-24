/**
 * Graph2DRenderer v2 — High-Effort 2D Renderer
 * 
 * This renderer is designed to look significantly more premium and "alive"
 * than the original, with deep integration for the new BrainSystem.
 *
 * Responsibilities:
 * - Own the force-graph instance for physics
 * - Take full control of canvas drawing for nodes, links, and brain effects
 * - Render particles coming from the BrainSystem
 * - Support rich per-node visual state (heat, glow, focus, etc.)
 */

export function createGraph2DRenderer(container, options = {}) {
  if (typeof window.ForceGraph !== 'function') {
    container.innerHTML = `<div style="padding: 2rem; color: #f66;">force-graph not loaded</div>`;
    return null;
  }

  container.innerHTML = '';

  const fg = ForceGraph()(container)
    .backgroundColor('transparent')
    .autoPauseRedraw(false)
    .nodeId('id')
    .nodeVal(n => Math.max(2.5, Math.sqrt(n.__degree || 1) * 4.2))
    .nodeRelSize(5.5)
    .linkColor(() => 'rgba(110, 130, 255, 0.18)')
    .linkWidth(l => 0.9 + (l.weight || 0.3) * 3.2)
    .linkCurvature(0.1)
    .onNodeHover(n => {
      container.style.cursor = n ? 'pointer' : 'default';
    });

  // We take full control of drawing
  fg.nodeCanvasObjectMode(() => 'replace');
  fg.nodeCanvasObject(drawNode);
  fg.linkCanvasObject(drawLink);

  // Draw brain particles on top after the main graph is rendered
  fg.onRenderFramePost((ctx, globalScale) => {
    drawParticles(ctx, globalScale);
  });

  let brainSnapshot = null;
  let particles = [];

  function drawNode(node, ctx, globalScale) {
    const r = (node.__size || 5) * (node.__brainScale || 1.0);
    const baseColor = node.__color || '#7aa2f7';

    const heat = node.__heat || 0;
    const glow = node.__glow || 0;
    const alpha = node.__brainAlpha ?? 0.95;

    ctx.save();
    ctx.globalAlpha = alpha;

    // Outer glow (brain heat / activation)
    if (heat > 0.05 || glow > 0.05) {
      const glowSize = r * (1.6 + heat * 1.8 + glow * 0.8);
      const gradient = ctx.createRadialGradient(
        node.x, node.y, r * 0.6,
        node.x, node.y, glowSize
      );
      gradient.addColorStop(0, `rgba(165, 180, 252, ${0.35 * Math.min(1, heat + glow)})`);
      gradient.addColorStop(0.4, `rgba(165, 180, 252, ${0.12 * Math.min(1, heat + glow)})`);
      gradient.addColorStop(1, 'rgba(165, 180, 252, 0)');

      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(node.x, node.y, glowSize, 0, Math.PI * 2);
      ctx.fill();
    }

    // Core node
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
    ctx.fillStyle = baseColor;
    ctx.fill();

    // Bright core when highly active
    if (heat > 0.3 || node.__focused) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, r * 0.55, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.65)';
      ctx.fill();
    }

    // Selection / Focus ring
    if (node.__selected || node.__focused) {
      ctx.strokeStyle = node.__focused ? '#67e8f9' : '#e0e7ff';
      ctx.lineWidth = (node.__focused ? 4.5 : 2.8) / globalScale;
      ctx.beginPath();
      ctx.arc(node.x, node.y, r + 3, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Zoom-aware labels (high effort polish)
    const labelZoomThreshold = 1.8;
    if (globalScale > labelZoomThreshold && node.label) {
      const fontSize = Math.max(2.8, 11 / globalScale);
      ctx.font = `${fontSize}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = `rgba(226, 232, 255, ${Math.min(0.95, (globalScale - labelZoomThreshold) * 0.6)})`;

      const label = node.label.length > 22 ? node.label.slice(0, 20) + '…' : node.label;
      ctx.fillText(label, node.x, node.y + r + fontSize + 2);
    }

    ctx.restore();
  }

  function drawLink(link, ctx, globalScale) {
    const start = link.source;
    const end = link.target;
    if (!start || !end || !start.x) return;

    const brainFlow = ((start.__heat || 0) + (end.__heat || 0)) * 0.5;

    ctx.save();
    ctx.strokeStyle = brainFlow > 0.15 
      ? `rgba(170, 210, 255, ${0.28 + brainFlow * 0.45})`
      : 'rgba(120, 140, 255, 0.22)';
    ctx.lineWidth = (0.85 + (link.weight || 0.3) * 3.5) / globalScale;
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
    ctx.restore();
  }

  function drawParticles(ctx, globalScale) {
    const particles = api._pendingParticles || [];
    if (!particles.length) return;

    ctx.save();

    for (const p of particles) {
      const progress = p.progress || 0;
      const alpha = (p.opacity || 0.7) * (1 - Math.min(1, progress * 1.1));

      if (alpha <= 0.02) continue;

      let x, y;

      if (p.type === 'ripple' || p.type === 'dream-wave') {
        // Expanding circles from a node
        const centerNode = fg.graphData().nodes.find(n => n.id === p.fromNodeId);
        if (!centerNode) continue;

        const radius = (p.size || 4) * (0.3 + progress * 2.8);
        ctx.strokeStyle = p.color || '#a5b4fc';
        ctx.globalAlpha = alpha * 0.7;
        ctx.lineWidth = (p.type === 'dream-wave' ? 2.5 : 1.8) / globalScale;

        ctx.beginPath();
        ctx.arc(centerNode.x, centerNode.y, radius, 0, Math.PI * 2);
        ctx.stroke();

      } else if (p.toNodeId) {
        // Traveling particles (spike, inference, ambient)
        const from = fg.graphData().nodes.find(n => n.id === p.fromNodeId);
        const to = fg.graphData().nodes.find(n => n.id === p.toNodeId);
        if (!from || !to) continue;

        const t = Math.min(1, progress);
        x = from.x + (to.x - from.x) * t;
        y = from.y + (to.y - from.y) * t;

        ctx.fillStyle = p.color || '#c7d2fe';
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.arc(x, y, (p.size || 2) / globalScale, 0, Math.PI * 2);
        ctx.fill();

        // Small trail
        ctx.globalAlpha = alpha * 0.4;
        ctx.beginPath();
        ctx.arc(x - (to.x - from.x) * 0.08, y - (to.y - from.y) * 0.08, (p.size || 2) * 0.6 / globalScale, 0, Math.PI * 2);
        ctx.fill();

      } else {
        // Simple particle from a node
        const from = fg.graphData().nodes.find(n => n.id === p.fromNodeId);
        if (!from) continue;

        const angle = (p.angle || 0) + progress * 6;
        const dist = (p.size || 8) * progress * 1.5;
        x = from.x + Math.cos(angle) * dist;
        y = from.y + Math.sin(angle) * dist;

        ctx.fillStyle = p.color || '#a5b4fc';
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.arc(x, y, (p.size || 2) / globalScale, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.restore();
  }

  // Resize handling
  const ro = new ResizeObserver(() => {
    fg.width(container.clientWidth).height(container.clientHeight);
  });
  ro.observe(container);
  fg.width(container.clientWidth).height(container.clientHeight);

  // Public API
  const api = {
    setData(graphData) {
      fg.graphData(graphData);
    },

    /**
     * Called every frame by GraphView with the latest brain snapshot.
     * This is where we push rich brain state into the nodes for drawing.
     */
    applyBrainState(brainSnap) {
      brainSnapshot = brainSnap;

      if (!fg.graphData().nodes) return;

      const nodeMap = new Map(fg.graphData().nodes.map(n => [n.id, n]));

      // Reset previous frame visuals
      for (const node of nodeMap.values()) {
        node.__heat = 0;
        node.__glow = 0;
        node.__brainScale = 1;
        node.__brainAlpha = 0.9;
        node.__focused = false;
      }

      if (brainSnap?.nodeActivity) {
        for (const [id, act] of brainSnap.nodeActivity) {
          const node = nodeMap.get(id);
          if (node) {
            node.__heat = act.heat ?? (act.activation * 0.75);
            node.__glow = act.glow ?? (act.activation * 0.6);
            node.__brainScale = 1 + (act.activation || 0) * 0.9;
            node.__brainAlpha = 0.65 + (act.activation || 0) * 0.35;
          }
        }
      }

      // Handle focus
      if (brainSnap?.attention?.globalFocus) {
        const focused = nodeMap.get(brainSnap.attention.globalFocus);
        if (focused) focused.__focused = true;
      }

      // Store particles for custom drawing (we'll enhance this)
      if (brainSnap?.particles) {
        api._pendingParticles = brainSnap.particles;
      }
    },

    fit(duration = 450, padding = 90) {
      fg.zoomToFit(duration, padding);
    },

    zoomIn() { fg.zoom(1.32, 260); },
    zoomOut() { fg.zoom(1 / 1.32, 260); },

    destroy() {
      ro.disconnect();
      container.innerHTML = '';
    },

    _fg: fg,
  };

  return api;
}
