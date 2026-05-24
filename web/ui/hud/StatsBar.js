/**
 * StatsBar — Clean, modern stats display for Graph UI v2
 * Shows node count, edge count, active brain nodes, etc.
 */

export function createStatsBar(container, stateManager, brainSystem) {
  const el = document.createElement('div');
  el.style.cssText = `
    position: absolute;
    bottom: 16px;
    right: 16px;
    background: rgba(10, 10, 18, 0.85);
    border: 1px solid rgba(120, 140, 255, 0.2);
    border-radius: 8px;
    padding: 8px 14px;
    font-size: 11px;
    color: #a5b4fc;
    backdrop-filter: blur(8px);
    display: flex;
    gap: 16px;
    font-family: system-ui, sans-serif;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
  `;

  const nodeStat = document.createElement('div');
  const activeStat = document.createElement('div');
  const edgeStat = document.createElement('div');

  [nodeStat, activeStat, edgeStat].forEach(stat => {
    stat.style.cssText = 'display: flex; flex-direction: column; align-items: center; min-width: 42px;';
    el.appendChild(stat);
  });

  container.appendChild(el);

  function update() {
    const s = stateManager.get();
    const brainSnap = brainSystem?.getSnapshot?.() || {};

    nodeStat.innerHTML = `
      <div style="font-size: 15px; font-weight: 600; color: #c7d2fe;">${s.nodes?.size || 0}</div>
      <div style="font-size: 9px; opacity: 0.6;">NODES</div>
    `;

    activeStat.innerHTML = `
      <div style="font-size: 15px; font-weight: 600; color: #67e8f9;">${brainSnap.nodeActivity?.size || 0}</div>
      <div style="font-size: 9px; opacity: 0.6;">ACTIVE</div>
    `;

    edgeStat.innerHTML = `
      <div style="font-size: 15px; font-weight: 600; color: #c7d2fe;">${s.edges?.size || 0}</div>
      <div style="font-size: 9px; opacity: 0.6;">EDGES</div>
    `;
  }

  // Subscribe to changes
  const unsubState = stateManager.subscribe(update);
  const unsubBrain = brainSystem?.subscribe?.(update);

  // Initial update
  update();

  return {
    el,
    update,
    destroy() {
      unsubState?.();
      unsubBrain?.();
      el.remove();
    }
  };
}
