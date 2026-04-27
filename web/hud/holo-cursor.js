// Visual Spec Part 2 §11 — Custom holo-cursor.
// Two positioned divs track the mouse over #canvas:
//   • crosshair (follows exactly, rotates 45° on mousedown)
//   • outer ring (smoothed 80ms transition; locks small on node hover)
// Plus a click-ripple element spawned on each mousedown inside the canvas.

import { state, subscribe } from '../state.js';

export function initHoloCursor() {
  const cursor = document.getElementById('holo-cursor');
  const canvas = document.getElementById('canvas');
  if (!cursor || !canvas) return null;

  const crosshair = cursor.querySelector('.crosshair');
  const ring = cursor.querySelector('.ring');
  if (!crosshair || !ring) return null;

  let inside = false;

  function move(e) {
    const x = e.clientX;
    const y = e.clientY;
    crosshair.style.transform = `translate(${x - 8}px, ${y - 8}px)${cursor.classList.contains('pressed') ? ' rotate(45deg)' : ' rotate(0deg)'}`;
    if (cursor.classList.contains('over-node')) {
      ring.style.transform = `translate(${x - 4}px, ${y - 4}px) scale(1)`;
    } else {
      ring.style.transform = `translate(${x - 16}px, ${y - 16}px) scale(1)`;
    }
  }

  canvas.addEventListener('mouseenter', (e) => {
    inside = true;
    cursor.classList.add('visible');
    move(e);
  });
  canvas.addEventListener('mouseleave', () => {
    inside = false;
    cursor.classList.remove('visible', 'pressed', 'over-node');
  });
  canvas.addEventListener('mousemove', (e) => {
    if (!inside) return;
    move(e);
  });
  canvas.addEventListener('mousedown', (e) => {
    cursor.classList.add('pressed');
    spawnRipple(e.clientX, e.clientY);
  });
  window.addEventListener('mouseup', () => {
    cursor.classList.remove('pressed');
  });

  // Hide the holo-cursor entirely on touch input.
  window.addEventListener('touchstart', () => {
    cursor.classList.remove('visible');
  }, { passive: true });

  // React to hover-state changes from the renderer (state.hoveredId is set
  // via setHovered() in the graph callbacks).
  subscribe((reason) => {
    if (reason !== 'hover-changed') return;
    cursor.classList.toggle('over-node', !!state.hoveredId);
    // Re-position ring at last known coord by reading transform — easier:
    // request next mousemove via a tiny synthetic update on next rAF.
  });

  return null;
}

function spawnRipple(x, y) {
  const el = document.createElement('div');
  el.className = 'cursor-ripple';
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  document.body.appendChild(el);
  // Remove once the 400ms animation has run (with a small safety buffer).
  setTimeout(() => { el.remove(); }, 460);
}
