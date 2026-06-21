import { type CSSProperties } from 'react';
import { colorForNodeType } from '@pkg/shared';
import { endpointId, type GraphLink, type GraphNode } from './types';

interface EdgeRow {
  link: GraphLink;
  otherId: string;
  direction: 'out' | 'in';
}

export function NodePanel({
  node,
  nodesById,
  links,
  onClose,
  onDelete,
  onExpand,
  onSelect,
}: {
  node: GraphNode;
  nodesById: Map<string, GraphNode>;
  links: GraphLink[];
  onClose: () => void;
  onDelete: (id: string) => void;
  onExpand: (id: string) => void;
  onSelect: (id: string) => void;
}): JSX.Element {
  const edges: EdgeRow[] = [];
  for (const link of links) {
    const s = endpointId(link.source);
    const t = endpointId(link.target);
    if (s === node.id) edges.push({ link, otherId: t, direction: 'out' });
    else if (t === node.id) edges.push({ link, otherId: s, direction: 'in' });
  }

  return (
    <aside style={panelStyle} aria-label="Node details">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ ...dot, background: colorForNodeType(node.type) }} />
          <strong style={{ fontSize: '1.02rem', wordBreak: 'break-word' }}>{node.label}</strong>
        </div>
        <button type="button" onClick={onClose} style={iconBtn} aria-label="Close panel">
          ✕
        </button>
      </div>

      <dl style={metaList}>
        <Meta label="Type" value={node.type} />
        <Meta label="Source" value={node.sourceId} />
        <Meta label="Created" value={formatDate(node.createdAt)} />
        <Meta label="Updated" value={formatDate(node.updatedAt)} />
        <Meta label="Degree" value={String(node.degree)} />
        {node.sourceUrl && (
          <Meta
            label="URL"
            value={
              <a href={node.sourceUrl} target="_blank" rel="noreferrer" style={{ color: '#7c9cff' }}>
                {node.sourceUrl}
              </a>
            }
          />
        )}
      </dl>

      {Object.keys(node.metadata ?? {}).length > 0 && (
        <details style={{ marginTop: 4 }}>
          <summary style={{ cursor: 'pointer', color: '#aab3cc', fontSize: '0.85rem' }}>
            Metadata ({Object.keys(node.metadata).length})
          </summary>
          <pre style={metaPre}>{JSON.stringify(node.metadata, null, 2)}</pre>
        </details>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <button type="button" style={primaryBtn} onClick={() => onExpand(node.id)}>
          Expand neighbourhood
        </button>
        {node.sourceUrl && (
          <a href={node.sourceUrl} target="_blank" rel="noreferrer" style={ghostBtn}>
            Open source
          </a>
        )}
        <button type="button" style={dangerBtn} onClick={() => onDelete(node.id)}>
          Delete
        </button>
      </div>

      <div style={{ marginTop: 16 }}>
        <strong style={{ fontSize: '0.82rem', color: '#aab3cc', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          Connections ({edges.length})
        </strong>
        <ul style={edgeList}>
          {edges.slice(0, 100).map(({ link, otherId, direction }) => {
            const other = nodesById.get(otherId);
            return (
              <li key={link.id}>
                <button type="button" style={edgeBtn} onClick={() => onSelect(otherId)} title={otherId}>
                  <span style={{ color: '#7b86a3' }}>{direction === 'out' ? '→' : '←'}</span>
                  <span style={{ color: '#8fa0c8', fontSize: '0.74rem' }}>{link.relation}</span>
                  <span style={{ color: '#dce5ff', wordBreak: 'break-word' }}>
                    {other ? other.label : otherId}
                  </span>
                </button>
              </li>
            );
          })}
          {edges.length === 0 && <li style={{ color: '#7b86a3', fontSize: '0.85rem' }}>No connections.</li>}
        </ul>
      </div>
    </aside>
  );
}

function Meta({ label, value }: { label: string; value: React.ReactNode }): JSX.Element {
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <dt style={{ color: '#7b86a3', minWidth: 70, fontSize: '0.82rem' }}>{label}</dt>
      <dd style={{ margin: 0, color: '#dce5ff', fontSize: '0.85rem', wordBreak: 'break-word' }}>{value}</dd>
    </div>
  );
}

function formatDate(value: string | undefined): string {
  if (!value) return '—';
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? value : new Date(ms).toLocaleString();
}

const panelStyle: CSSProperties = {
  position: 'absolute',
  top: 12,
  right: 12,
  bottom: 12,
  width: 340,
  overflowY: 'auto',
  background: 'rgba(17,23,42,0.94)',
  border: '1px solid #1f2740',
  borderRadius: 16,
  padding: '1rem',
  boxShadow: '0 24px 70px rgba(0,0,0,0.45)',
  backdropFilter: 'blur(6px)',
  zIndex: 5,
};
const dot: CSSProperties = { width: 12, height: 12, borderRadius: 999, flex: '0 0 auto' };
const metaList: CSSProperties = { display: 'grid', gap: 6, margin: '12px 0 0' };
const metaPre: CSSProperties = {
  background: '#0a0e1a',
  border: '1px solid #1c2540',
  borderRadius: 10,
  padding: 10,
  fontSize: '0.74rem',
  color: '#9fb0d6',
  maxHeight: 200,
  overflow: 'auto',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};
const edgeList: CSSProperties = { listStyle: 'none', padding: 0, margin: '8px 0 0', display: 'grid', gap: 4 };
const edgeBtn: CSSProperties = {
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
const iconBtn: CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: '#8fa0c8',
  cursor: 'pointer',
  fontSize: '1rem',
};
const baseBtn: CSSProperties = {
  borderRadius: 10,
  padding: '0.5rem 0.7rem',
  fontSize: '0.82rem',
  fontWeight: 600,
  cursor: 'pointer',
  border: '1px solid #26304d',
  textDecoration: 'none',
  display: 'inline-block',
};
const primaryBtn: CSSProperties = { ...baseBtn, background: '#7c9cff', color: '#06112b', border: '1px solid #7c9cff' };
const ghostBtn: CSSProperties = { ...baseBtn, background: '#121a2e', color: '#dce5ff' };
const dangerBtn: CSSProperties = { ...baseBtn, background: '#1e1217', color: '#ffb7c4', border: '1px solid #5b2330' };
