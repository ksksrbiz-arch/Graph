import { useMemo, useState, type CSSProperties } from 'react';
import { colorForNodeType } from '@pkg/shared';
import type { GraphNode } from './types';

const PAGE_SIZE = 300;

interface DayGroup {
  key: string;
  label: string;
  nodes: GraphNode[];
}

/** Chronological list of nodes (spec §7.4): newest first, grouped by day, with
 *  a from/to date-range filter. Self-contained and presentational — the parent
 *  coordinator owns selection state and supplies the callbacks. */
export function TimelineView({
  nodes,
  onSelect,
  onClose,
}: {
  nodes: GraphNode[];
  onSelect: (id: string) => void;
  onClose: () => void;
}): JSX.Element {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [limit, setLimit] = useState(PAGE_SIZE);

  // Parse the inclusive date-range bounds once per change. The `<input
  // type="date">` value is a local calendar day, so interpret it in local time
  // to stay consistent with the local-time day grouping/display below. `to`
  // covers the full day, so push it to the end of the selected day.
  const fromMs = useMemo(() => localDayStart(from), [from]);
  const toMs = useMemo(() => {
    const start = localDayStart(to);
    return start === undefined ? undefined : start + DAY_MS - 1;
  }, [to]);

  // Sort by createdAt descending; nodes with an unparseable/missing date sink
  // to the bottom and are excluded when a range filter is active.
  const sorted = useMemo(() => {
    return nodes
      .map((node) => ({ node, ms: Date.parse(node.createdAt ?? '') }))
      .sort((a, b) => {
        const an = Number.isNaN(a.ms);
        const bn = Number.isNaN(b.ms);
        if (an && bn) return 0;
        if (an) return 1;
        if (bn) return -1;
        return b.ms - a.ms;
      });
  }, [nodes]);

  const filtered = useMemo(() => {
    return sorted.filter(({ ms }) => {
      if (fromMs === undefined && toMs === undefined) return true;
      if (Number.isNaN(ms)) return false;
      if (fromMs !== undefined && ms < fromMs) return false;
      if (toMs !== undefined && ms > toMs) return false;
      return true;
    });
  }, [sorted, fromMs, toMs]);

  const visible = filtered.slice(0, limit);

  const groups = useMemo(() => {
    const out: DayGroup[] = [];
    let current: DayGroup | undefined;
    for (const { node, ms } of visible) {
      const key = Number.isNaN(ms) ? 'unknown' : dayKey(ms);
      if (!current || current.key !== key) {
        current = { key, label: Number.isNaN(ms) ? 'Unknown date' : dayLabel(ms), nodes: [] };
        out.push(current);
      }
      current.nodes.push(node);
    }
    return out;
  }, [visible]);

  const hasMore = filtered.length > visible.length;

  return (
    <aside style={panelStyle} aria-label="Timeline">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <strong style={{ fontSize: '1.02rem' }}>Timeline</strong>
        <button type="button" onClick={onClose} style={iconBtn} aria-label="Close timeline">
          ✕
        </button>
      </div>

      <div style={filterRow}>
        <label style={filterLabel}>
          From
          <input
            type="date"
            value={from}
            max={to || undefined}
            onChange={(e) => {
              setFrom(e.target.value);
              setLimit(PAGE_SIZE);
            }}
            style={dateInput}
          />
        </label>
        <label style={filterLabel}>
          To
          <input
            type="date"
            value={to}
            min={from || undefined}
            onChange={(e) => {
              setTo(e.target.value);
              setLimit(PAGE_SIZE);
            }}
            style={dateInput}
          />
        </label>
        {(from || to) && (
          <button
            type="button"
            style={clearBtn}
            onClick={() => {
              setFrom('');
              setTo('');
              setLimit(PAGE_SIZE);
            }}
          >
            Clear
          </button>
        )}
      </div>

      <div style={{ color: '#7b86a3', fontSize: '0.78rem', margin: '8px 0 4px' }}>
        {filtered.length} {filtered.length === 1 ? 'node' : 'nodes'}
        {hasMore ? ` · showing ${visible.length}` : ''}
      </div>

      <div style={scrollArea}>
        {groups.map((group) => (
          <section key={group.key}>
            <h3 style={dayHeading}>{group.label}</h3>
            <ul style={rowList}>
              {group.nodes.map((node) => (
                <li key={node.id}>
                  <button type="button" style={rowBtn} onClick={() => onSelect(node.id)} title={node.label}>
                    <span style={{ ...dot, background: colorForNodeType(node.type) }} />
                    <span style={rowLabel}>{node.label}</span>
                    <span style={rowType}>{node.type}</span>
                    <span style={rowTime}>{formatTime(node.createdAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {filtered.length === 0 && <p style={{ color: '#7b86a3', fontSize: '0.85rem' }}>No nodes in range.</p>}
        {hasMore && (
          <button type="button" style={moreBtn} onClick={() => setLimit((n) => n + PAGE_SIZE)}>
            Show more ({filtered.length - visible.length} remaining)
          </button>
        )}
      </div>
    </aside>
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Parse a `YYYY-MM-DD` date-input value as the start of that day in local
 *  time (not UTC), matching how rows are grouped/displayed. Returns undefined
 *  for empty or malformed input. */
function localDayStart(value: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const ms = new Date(year, month - 1, day).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function formatTime(value: string | undefined): string {
  if (!value) return '—';
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? value : new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

const panelStyle: CSSProperties = {
  position: 'absolute',
  top: 12,
  left: 12,
  bottom: 12,
  width: 360,
  display: 'flex',
  flexDirection: 'column',
  background: 'rgba(17,23,42,0.94)',
  border: '1px solid #1f2740',
  borderRadius: 16,
  padding: '1rem',
  boxShadow: '0 24px 70px rgba(0,0,0,0.45)',
  backdropFilter: 'blur(6px)',
  zIndex: 5,
};
const filterRow: CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'flex-end',
  flexWrap: 'wrap',
  marginTop: 12,
};
const filterLabel: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  color: '#7b86a3',
  fontSize: '0.74rem',
};
const dateInput: CSSProperties = {
  background: '#0d1324',
  border: '1px solid #1c2540',
  borderRadius: 8,
  padding: '0.35rem 0.45rem',
  color: '#dce5ff',
  fontSize: '0.8rem',
  colorScheme: 'dark',
};
const scrollArea: CSSProperties = {
  overflowY: 'auto',
  flex: 1,
  marginTop: 4,
};
const dayHeading: CSSProperties = {
  position: 'sticky',
  top: 0,
  margin: '8px 0 4px',
  padding: '4px 0',
  background: 'rgba(17,23,42,0.94)',
  color: '#aab3cc',
  fontSize: '0.74rem',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  fontWeight: 600,
};
const rowList: CSSProperties = { listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 4 };
const rowBtn: CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'center',
  width: '100%',
  textAlign: 'left',
  background: '#0d1324',
  border: '1px solid #1c2540',
  borderRadius: 8,
  padding: '0.4rem 0.55rem',
  color: '#dce5ff',
  cursor: 'pointer',
  fontSize: '0.82rem',
};
const dot: CSSProperties = { width: 10, height: 10, borderRadius: 999, flex: '0 0 auto' };
const rowLabel: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
const rowType: CSSProperties = { color: '#8fa0c8', fontSize: '0.72rem', flex: '0 0 auto' };
const rowTime: CSSProperties = { color: '#7b86a3', fontSize: '0.72rem', flex: '0 0 auto' };
const iconBtn: CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: '#8fa0c8',
  cursor: 'pointer',
  fontSize: '1rem',
};
const clearBtn: CSSProperties = {
  background: '#121a2e',
  border: '1px solid #26304d',
  borderRadius: 8,
  padding: '0.35rem 0.6rem',
  color: '#dce5ff',
  cursor: 'pointer',
  fontSize: '0.78rem',
};
const moreBtn: CSSProperties = {
  width: '100%',
  marginTop: 8,
  background: '#121a2e',
  border: '1px solid #26304d',
  borderRadius: 10,
  padding: '0.5rem 0.7rem',
  color: '#dce5ff',
  cursor: 'pointer',
  fontSize: '0.82rem',
  fontWeight: 600,
};
