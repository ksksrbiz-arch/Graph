/**
 * BrainStatus — Simple but beautiful brain state HUD for UI v2
 */

export function createBrainStatus(container, brainSystem) {
  const el = document.createElement('div');
  el.style.cssText = `
    position: absolute; top: 16px; right: 16px;
    background: rgba(10, 10, 18, 0.82);
    border: 1px solid rgba(120, 140, 255, 0.2);
    border-radius: 6px;
    padding: 8px 14px;
    font-size: 12px;
    font-family: system-ui, sans-serif;
    color: #a5b4fc;
    backdrop-filter: blur(6px);
    pointer-events: none;
    min-width: 128px;
  `;

  container.appendChild(el);

  let currentMode = 'awake';

  function update(snapshot) {
    if (!snapshot) return;

    const mode = snapshot.mode?.current || 'awake';
    const intensity = snapshot.mode?.intensity || 1;

    let html = `<div style="font-weight:600; margin-bottom:2px;">BRAIN</div>`;
    html += `<div style="display:flex; justify-content:space-between; font-size:11px; opacity:0.9;">`;
    html += `<span>${mode.toUpperCase()}</span>`;
    html += `<span>${(intensity * 100).toFixed(0)}%</span>`;
    html += `</div>`;

    if (snapshot.attention?.globalFocus) {
      html += `<div style="margin-top:3px; font-size:10px; color:#67e8f9;">Focused</div>`;
    }

    el.innerHTML = html;
    currentMode = mode;
  }

  if (brainSystem) {
    brainSystem.subscribe(update);
  }

  return {
    el,
    destroy() {
      el.remove();
    }
  };
}
