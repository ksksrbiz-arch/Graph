import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { colorForNodeType } from '@pkg/shared';
import type { GraphNode } from './types';

/** A simple pan/zoom transform mirroring d3-zoom: screen = graph * k + {x,y}. */
export interface MiniMapTransform {
  x: number;
  y: number;
  k: number;
}

const CANVAS_W = 180;
const CANVAS_H = 120;
const PAD = 6;

/** Collapsible minimap (AC-F12). Presentational only: plots node positions
 *  scaled to their bounding box, overlays the current viewport rectangle, and
 *  reports graph-space coordinates back via `onJump` when clicked. The parent
 *  owns the canvas/force layout and wires this in. */
export function MiniMap({
  nodes,
  transform,
  width,
  height,
  onJump,
}: {
  nodes: GraphNode[];
  transform: MiniMapTransform;
  width: number;
  height: number;
  onJump: (graphX: number, graphY: number) => void;
}): JSX.Element {
  const [open, setOpen] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Compute the bounding box of all positioned nodes in graph space.
  const placed = nodes.filter((n) => typeof n.x === 'number' && typeof n.y === 'number');
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of placed) {
    const nx = n.x ?? 0;
    const ny = n.y ?? 0;
    if (nx < minX) minX = nx;
    if (ny < minY) minY = ny;
    if (nx > maxX) maxX = nx;
    if (ny > maxY) maxY = ny;
  }
  const hasBounds = placed.length > 0 && Number.isFinite(minX) && Number.isFinite(minY);
  // Fall back to a unit box so scale math never divides by zero.
  const boxW = hasBounds ? Math.max(maxX - minX, 1) : 1;
  const boxH = hasBounds ? Math.max(maxY - minY, 1) : 1;
  const originX = hasBounds ? minX : 0;
  const originY = hasBounds ? minY : 0;

  const innerW = CANVAS_W - PAD * 2;
  const innerH = CANVAS_H - PAD * 2;
  // Uniform scale that fits the bounding box into the inner canvas area.
  const scale = Math.min(innerW / boxW, innerH / boxH);
  // Centre the scaled box within the canvas.
  const offsetX = PAD + (innerW - boxW * scale) / 2;
  const offsetY = PAD + (innerH - boxH * scale) / 2;

  const graphToMini = (gx: number, gy: number): [number, number] => [
    offsetX + (gx - originX) * scale,
    offsetY + (gy - originY) * scale,
  ];
  const miniToGraph = (mx: number, my: number): [number, number] => [
    (mx - offsetX) / scale + originX,
    (my - offsetY) / scale + originY,
  ];

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !open) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.fillStyle = '#0a0e1a';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    // Plot nodes.
    for (const n of placed) {
      const [mx, my] = graphToMini(n.x ?? 0, n.y ?? 0);
      ctx.beginPath();
      ctx.fillStyle = colorForNodeType(n.type);
      ctx.arc(mx, my, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }

    // Overlay the current viewport rectangle. The screen corners (0,0) and
    // (width,height) map back into graph space via the inverse transform, then
    // into minimap space.
    if (transform.k !== 0 && width > 0 && height > 0) {
      const gx0 = (0 - transform.x) / transform.k;
      const gy0 = (0 - transform.y) / transform.k;
      const gx1 = (width - transform.x) / transform.k;
      const gy1 = (height - transform.y) / transform.k;
      const [vx0, vy0] = graphToMini(gx0, gy0);
      const [vx1, vy1] = graphToMini(gx1, gy1);
      const rx = Math.min(vx0, vx1);
      const ry = Math.min(vy0, vy1);
      const rw = Math.abs(vx1 - vx0);
      const rh = Math.abs(vy1 - vy0);
      ctx.strokeStyle = '#7c9cff';
      ctx.lineWidth = 1;
      ctx.strokeRect(rx, ry, rw, rh);
      ctx.fillStyle = 'rgba(124,156,255,0.12)';
      ctx.fillRect(rx, ry, rw, rh);
    }
  }, [placed, transform, width, height, open, scale, offsetX, offsetY, originX, originY]);

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    // Map client → canvas pixel space (account for any CSS scaling).
    const mx = ((e.clientX - rect.left) / rect.width) * CANVAS_W;
    const my = ((e.clientY - rect.top) / rect.height) * CANVAS_H;
    const [gx, gy] = miniToGraph(mx, my);
    onJump(gx, gy);
  };

  return (
    <div style={wrap}>
      <button type="button" style={header} onClick={() => setOpen((v) => !v)}>
        <span>Minimap{placed.length > 0 ? ` · ${placed.length}` : ''}</span>
        <span style={{ color: '#7b86a3' }}>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div style={{ padding: '0 6px 6px' }}>
          <canvas
            ref={canvasRef}
            width={CANVAS_W}
            height={CANVAS_H}
            onClick={handleClick}
            style={canvasStyle}
            aria-label="Graph minimap, click to jump"
          />
        </div>
      )}
    </div>
  );
}

const wrap: CSSProperties = {
  position: 'absolute',
  bottom: 12,
  right: 12,
  background: 'rgba(17,23,42,0.94)',
  border: '1px solid #1f2740',
  borderRadius: 14,
  boxShadow: '0 18px 50px rgba(0,0,0,0.4)',
  backdropFilter: 'blur(6px)',
  zIndex: 4,
};
const header: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  width: '100%',
  background: 'transparent',
  border: 'none',
  color: '#e8edf6',
  padding: 10,
  fontWeight: 700,
  fontSize: '0.85rem',
  cursor: 'pointer',
};
const canvasStyle: CSSProperties = {
  display: 'block',
  width: CANVAS_W,
  height: CANVAS_H,
  borderRadius: 8,
  border: '1px solid #1c2540',
  cursor: 'crosshair',
};
