/**
 * Controls — Basic but beautiful control panel for Graph UI v2
 * (Zoom, fit, mode triggers, etc.)
 */

export function createControls(container, graphView) {
  const el = document.createElement('div');
  el.style.cssText = `
    position: absolute; bottom: 16px; left: 16px;
    background: rgba(10, 10, 18, 0.82);
    border: 1px solid rgba(120, 140, 255, 0.2);
    border-radius: 8px;
    padding: 6px;
    display: flex;
    gap: 4px;
    backdrop-filter: blur(6px);
  `;

  const makeBtn = (label, action) => {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.style.cssText = `
      background: rgba(30, 30, 45, 0.9);
      color: #c7d2fe;
      border: 1px solid rgba(120, 140, 255, 0.3);
      border-radius: 6px;
      padding: 6px 10px;
      font-size: 12px;
      cursor: pointer;
      transition: all 0.1s;
    `;
    btn.onmouseenter = () => btn.style.background = 'rgba(50, 50, 80, 0.95)';
    btn.onmouseleave = () => btn.style.background = 'rgba(30, 30, 45, 0.9)';
    btn.onclick = action;
    return btn;
  };

  el.appendChild(makeBtn('Fit', () => graphView.renderer?.fit?.(400)));
  el.appendChild(makeBtn('Zoom +', () => graphView.renderer?.zoomIn?.()));
  el.appendChild(makeBtn('Zoom −', () => graphView.renderer?.zoomOut?.()));
  el.appendChild(makeBtn('Dream', () => graphView.brainSystem?.enterDreamMode?.(0.85)));
  el.appendChild(makeBtn('Wake', () => graphView.brainSystem?.exitDreamMode?.()));

  container.appendChild(el);

  return { el, destroy: () => el.remove() };
}
