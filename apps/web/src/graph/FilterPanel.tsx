import { useState, type CSSProperties } from 'react';
import { colorForNodeType } from '@pkg/shared';

/** Client-side node-type masking (AC-F09). Toggling never re-fetches; the
 *  parent simply hides nodes/links whose type is in `hidden`. */
export function FilterPanel({
  typeCounts,
  hidden,
  onToggle,
  onReset,
}: {
  typeCounts: Array<[string, number]>;
  hidden: Set<string>;
  onToggle: (type: string) => void;
  onReset: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(true);
  const hiddenCount = hidden.size;

  return (
    <div style={wrap}>
      <button type="button" style={header} onClick={() => setOpen((v) => !v)}>
        <span>Filters{hiddenCount > 0 ? ` · ${hiddenCount} hidden` : ''}</span>
        <span style={{ color: '#7b86a3' }}>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div style={{ padding: '0 10px 10px' }}>
          {hiddenCount > 0 && (
            <button type="button" style={resetBtn} onClick={onReset}>
              Show all
            </button>
          )}
          <ul style={list}>
            {typeCounts.map(([type, count]) => {
              const isHidden = hidden.has(type);
              return (
                <li key={type}>
                  <label style={{ ...row, opacity: isHidden ? 0.45 : 1 }}>
                    <input
                      type="checkbox"
                      checked={!isHidden}
                      onChange={() => onToggle(type)}
                      style={{ accentColor: colorForNodeType(type) }}
                    />
                    <span style={{ ...swatch, background: colorForNodeType(type) }} />
                    <span style={{ flex: 1 }}>{type}</span>
                    <span style={{ color: '#7b86a3' }}>{count}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

const wrap: CSSProperties = {
  position: 'absolute',
  top: 12,
  left: 12,
  width: 230,
  background: 'rgba(17,23,42,0.94)',
  border: '1px solid #1f2740',
  borderRadius: 14,
  boxShadow: '0 18px 50px rgba(0,0,0,0.4)',
  backdropFilter: 'blur(6px)',
  zIndex: 4,
  maxHeight: 'calc(100% - 24px)',
  overflowY: 'auto',
};
const header: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  width: '100%',
  background: 'transparent',
  border: 'none',
  color: '#e8edf6',
  padding: 12,
  fontWeight: 700,
  fontSize: '0.85rem',
  cursor: 'pointer',
};
const list: CSSProperties = { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 2 };
const row: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: '0.8rem',
  color: '#dce5ff',
  cursor: 'pointer',
  padding: '0.2rem 0',
};
const swatch: CSSProperties = { width: 10, height: 10, borderRadius: 3 };
const resetBtn: CSSProperties = {
  background: '#121a2e',
  border: '1px solid #26304d',
  color: '#dce5ff',
  borderRadius: 8,
  padding: '0.35rem 0.6rem',
  fontSize: '0.78rem',
  cursor: 'pointer',
  marginBottom: 8,
  width: '100%',
};
