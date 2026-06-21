import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import ForceGraph2D, {
  type ForceGraphMethods,
  type LinkObject,
  type NodeObject,
} from 'react-force-graph-2d';
import { colorForNodeType, type KGNode, type KGEdge } from '@pkg/shared';
import { fetchSnapshot, fetchSubgraph, deleteNode, searchNodes } from './api';
import { endpointId, toViewGraph, type GraphLink, type GraphNode } from './types';
import { NodePanel } from './NodePanel';
import { FilterPanel } from './FilterPanel';
import { ContextMenu, type ContextMenuState } from './ContextMenu';

type FgNode = NodeObject<GraphNode>;
type FgLink = LinkObject<GraphNode, GraphLink>;
type FgMethods = ForceGraphMethods<FgNode, FgLink>;

interface FocusState {
  rootId: string;
  ids: Set<string>;
}

/** Node radius in graph units: degree-encoded, clamped to 4–24 (AC-F03). */
function radiusOf(node: GraphNode): number {
  return 4 + Math.min(20, Math.sqrt(node.degree) * 3);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Hover tooltip body (AC-F04): label, type, source, updatedAt. */
function tooltipHtml(node: GraphNode): string {
  const rows = [
    `<div style="font-weight:600;margin-bottom:4px">${escapeHtml(node.label)}</div>`,
    `<div style="color:#9caad0">type: ${escapeHtml(node.type)}</div>`,
    node.sourceUrl ? `<div style="color:#7c9cff">${escapeHtml(node.sourceUrl)}</div>` : '',
    `<div style="color:#7b86a3">updated: ${escapeHtml(node.updatedAt)}</div>`,
  ];
  return `<div style="background:rgba(13,19,36,0.96);border:1px solid #26304d;border-radius:8px;padding:6px 8px;font:12px ui-sans-serif,system-ui,sans-serif;color:#e8edf6;max-width:280px">${rows.join('')}</div>`;
}

export function GraphView({ userId }: { userId: string }): JSX.Element {
  const fgRef = useRef<FgMethods | undefined>(undefined);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const lastClick = useRef<{ id: string; at: number } | null>(null);

  const [raw, setRaw] = useState<{ nodes: KGNode[]; edges: KGEdge[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dims, setDims] = useState({ width: 800, height: 600 });

  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [primaryId, setPrimaryId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [focus, setFocus] = useState<FocusState | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<KGNode[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  // ── Data load ────────────────────────────────────────────────
  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const snap = await fetchSnapshot(userId);
      setRaw({ nodes: snap.nodes, edges: snap.edges });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // ── Responsive sizing ────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setDims({ width: Math.max(320, r.width), height: Math.max(320, r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── Derived view model ───────────────────────────────────────
  const view = useMemo(
    () => (raw ? toViewGraph(raw.nodes, raw.edges) : { nodes: [], links: [] }),
    [raw],
  );

  const nodesById = useMemo(() => {
    const m = new Map<string, GraphNode>();
    for (const n of view.nodes) m.set(n.id, n);
    return m;
  }, [view]);

  const adjacency = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const l of view.links) {
      const s = endpointId(l.source);
      const t = endpointId(l.target);
      (m.get(s) ?? m.set(s, new Set()).get(s)!).add(t);
      (m.get(t) ?? m.set(t, new Set()).get(t)!).add(s);
    }
    return m;
  }, [view]);

  const typeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of view.nodes) counts.set(n.type, (counts.get(n.type) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [view]);

  const neighbours = useMemo(
    () => (hoveredId ? (adjacency.get(hoveredId) ?? new Set<string>()) : null),
    [hoveredId, adjacency],
  );

  // ── Visibility (filters + focus) ─────────────────────────────
  const nodeVisible = useCallback(
    (n: GraphNode): boolean => {
      if (hidden.has(n.type)) return false;
      if (focus && !focus.ids.has(n.id)) return false;
      return true;
    },
    [hidden, focus],
  );

  // ── Interaction handlers ─────────────────────────────────────
  const selectNode = useCallback((id: string, additive = false) => {
    setMenu(null);
    setPrimaryId(id);
    setSelectedIds((prev) => {
      if (!additive) return new Set([id]);
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const centerOn = useCallback((node: GraphNode | undefined) => {
    if (node && node.x != null && node.y != null) {
      fgRef.current?.centerAt(node.x, node.y, 700);
      fgRef.current?.zoom(2.4, 700);
    }
  }, []);

  const focusEgo = useCallback(
    async (rootId: string) => {
      setMenu(null);
      let ids: Set<string>;
      try {
        const sg = await fetchSubgraph(userId, rootId, 2);
        ids = new Set(sg.nodes.map((n) => n.id));
      } catch {
        // Fall back to a local depth-2 BFS if the endpoint is unavailable.
        ids = new Set([rootId]);
        let frontier = [rootId];
        for (let depth = 0; depth < 2; depth += 1) {
          const next: string[] = [];
          for (const id of frontier) {
            for (const nb of adjacency.get(id) ?? []) {
              if (!ids.has(nb)) {
                ids.add(nb);
                next.push(nb);
              }
            }
          }
          frontier = next;
        }
      }
      ids.add(rootId);
      setFocus({ rootId, ids });
      setPrimaryId(rootId);
      setSelectedIds(new Set([rootId]));
      window.setTimeout(() => fgRef.current?.zoomToFit(600, 50, (n) => ids.has((n as FgNode).id)), 60);
    },
    [userId, adjacency],
  );

  const handleDelete = useCallback(
    async (ids: string[]) => {
      setMenu(null);
      const failed: string[] = [];
      for (const id of ids) {
        try {
          await deleteNode(userId, id);
        } catch {
          failed.push(id);
        }
      }
      const removed = new Set(ids.filter((id) => !failed.includes(id)));
      if (removed.size > 0) {
        setRaw((prev) =>
          prev
            ? {
                nodes: prev.nodes.filter((n) => !removed.has(n.id)),
                edges: prev.edges.filter((e) => !removed.has(e.source) && !removed.has(e.target)),
              }
            : prev,
        );
        setSelectedIds(new Set());
        setPrimaryId(null);
      }
      setNotice(
        failed.length > 0
          ? `Deleted ${removed.size}, failed ${failed.length}`
          : `Deleted ${removed.size} node${removed.size === 1 ? '' : 's'}`,
      );
    },
    [userId],
  );

  const runSearch = useCallback(
    async (q: string) => {
      if (!q.trim()) {
        setResults([]);
        return;
      }
      try {
        const found = await searchNodes(userId, q.trim(), 12);
        setResults(found);
      } catch {
        // Fall back to a local label match if Meilisearch isn't reachable.
        const needle = q.trim().toLowerCase();
        setResults(view.nodes.filter((n) => n.label.toLowerCase().includes(needle)).slice(0, 12));
      }
    },
    [userId, view],
  );

  useEffect(() => {
    const t = window.setTimeout(() => void runSearch(query), 220);
    return () => window.clearTimeout(t);
  }, [query, runSearch]);

  // ── Keyboard shortcuts ───────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (e.key === 'f' || e.key === 'F') {
        fgRef.current?.zoomToFit(500, 50);
      } else if (e.key === 'Escape') {
        setMenu(null);
        setPrimaryId(null);
        setSelectedIds(new Set());
        if (focus) setFocus(null);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.size > 0) {
        void handleDelete([...selectedIds]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedIds, focus, handleDelete]);

  const primaryNode = primaryId ? nodesById.get(primaryId) : undefined;

  return (
    <div ref={containerRef} style={shell}>
      <ForceGraph2D<GraphNode, GraphLink>
        ref={fgRef}
        width={dims.width}
        height={dims.height}
        graphData={view}
        backgroundColor="#0b0f1a"
        nodeId="id"
        nodeRelSize={1}
        nodeLabel={(n) => tooltipHtml(n as FgNode)}
        nodeVisibility={(n) => nodeVisible(n as FgNode)}
        linkVisibility={(l) => {
          const s = nodesById.get(endpointId((l as FgLink).source));
          const t = nodesById.get(endpointId((l as FgLink).target));
          return Boolean(s && t && nodeVisible(s) && nodeVisible(t));
        }}
        linkColor={(l) => ((l as FgLink).inferred ? 'rgba(124,156,255,0.22)' : 'rgba(150,165,200,0.35)')}
        linkWidth={(l) => 0.4 + (l as FgLink).weight * 1.6}
        linkLineDash={(l) => ((l as FgLink).inferred ? [2, 3] : null)}
        onNodeHover={(n) => setHoveredId(n ? (n as FgNode).id : null)}
        onNodeClick={(n, evt) => {
          const id = (n as FgNode).id;
          const now = Date.now();
          // Double-click (same node within 300ms) re-centres on the ego-network.
          if (!evt.shiftKey && lastClick.current?.id === id && now - lastClick.current.at < 300) {
            lastClick.current = null;
            void focusEgo(id);
            return;
          }
          lastClick.current = { id, at: now };
          selectNode(id, evt.shiftKey);
        }}
        onNodeRightClick={(n, evt) => {
          evt.preventDefault();
          setMenu({ x: evt.clientX, y: evt.clientY, node: n as FgNode });
        }}
        onBackgroundClick={() => {
          setMenu(null);
          setPrimaryId(null);
          setSelectedIds(new Set());
        }}
        onNodeDragEnd={(n) => {
          const node = n as FgNode;
          node.fx = node.x;
          node.fy = node.y;
        }}
        nodePointerAreaPaint={(n, color, ctx) => {
          const node = n as FgNode;
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(node.x ?? 0, node.y ?? 0, radiusOf(node), 0, 2 * Math.PI);
          ctx.fill();
        }}
        nodeCanvasObject={(n, ctx, scale) => {
          const node = n as FgNode;
          const r = radiusOf(node);
          const dimmed = neighbours ? !(neighbours.has(node.id) || node.id === hoveredId) : false;
          const selected = selectedIds.has(node.id);
          ctx.globalAlpha = dimmed ? 0.12 : 1;
          ctx.beginPath();
          ctx.arc(node.x ?? 0, node.y ?? 0, r, 0, 2 * Math.PI);
          ctx.fillStyle = colorForNodeType(node.type);
          ctx.fill();
          if (selected || node.id === hoveredId) {
            ctx.lineWidth = 2 / scale;
            ctx.strokeStyle = selected ? '#ffffff' : '#cdd7f5';
            ctx.stroke();
          }
          if (scale > 1.4 || selected || node.id === hoveredId) {
            const label = node.label.length > 28 ? `${node.label.slice(0, 27)}…` : node.label;
            ctx.font = `${11 / scale}px ui-sans-serif, system-ui, sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillStyle = dimmed ? 'rgba(200,210,235,0.3)' : '#dfe6f5';
            ctx.fillText(label, node.x ?? 0, (node.y ?? 0) + r + 1.5);
          }
          ctx.globalAlpha = 1;
        }}
      />

      <FilterPanel
        typeCounts={typeCounts}
        hidden={hidden}
        onToggle={(type) =>
          setHidden((prev) => {
            const next = new Set(prev);
            if (next.has(type)) next.delete(type);
            else next.add(type);
            return next;
          })
        }
        onReset={() => setHidden(new Set())}
      />

      <div style={toolbar}>
        <div style={{ position: 'relative' }}>
          <input
            aria-label="Search nodes"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search nodes…"
            style={searchInput}
          />
          {results.length > 0 && (
            <ul style={resultsList}>
              {results.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    style={resultBtn}
                    onClick={() => {
                      setQuery('');
                      setResults([]);
                      selectNode(r.id);
                      centerOn(nodesById.get(r.id));
                    }}
                  >
                    <span style={{ ...swatch, background: colorForNodeType(r.type) }} />
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.label}
                    </span>
                    <span style={{ color: '#7b86a3', fontSize: '0.72rem' }}>{r.type}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <button type="button" style={toolBtn} onClick={() => fgRef.current?.zoomToFit(500, 50)} title="Fit to screen (F)">
          Fit
        </button>
        <button type="button" style={toolBtn} onClick={() => void reload()} title="Reload graph">
          Reload
        </button>
        {selectedIds.size > 1 && (
          <button
            type="button"
            style={{ ...toolBtn, color: '#ffb7c4', borderColor: '#5b2330' }}
            onClick={() => void handleDelete([...selectedIds])}
          >
            Delete {selectedIds.size}
          </button>
        )}
        <span style={countPill}>
          {view.nodes.length} nodes · {view.links.length} edges
        </span>
      </div>

      {focus && (
        <div style={focusBanner}>
          <span>
            Focused on <strong>{nodesById.get(focus.rootId)?.label ?? focus.rootId}</strong> · depth 2 ·{' '}
            {focus.ids.size} nodes
          </span>
          <button type="button" style={exitFocusBtn} onClick={() => setFocus(null)}>
            Exit focus
          </button>
        </div>
      )}

      {notice && (
        <div style={noticeToast} onAnimationEnd={() => setNotice(null)}>
          {notice}
        </div>
      )}

      {loading && <div style={overlay}>Loading graph…</div>}
      {error && !loading && (
        <div style={{ ...overlay, color: '#ffb7c4' }}>
          <div>
            <div style={{ marginBottom: 10 }}>Couldn’t load graph: {error}</div>
            <button type="button" style={toolBtn} onClick={() => void reload()}>
              Retry
            </button>
          </div>
        </div>
      )}
      {!loading && !error && view.nodes.length === 0 && (
        <div style={overlay}>No graph data yet for “{userId}”. Ingest some sources to populate it.</div>
      )}

      {primaryNode && (
        <NodePanel
          node={primaryNode}
          nodesById={nodesById}
          links={view.links}
          onClose={() => {
            setPrimaryId(null);
            setSelectedIds(new Set());
          }}
          onDelete={(id) => void handleDelete([id])}
          onExpand={(id) => void focusEgo(id)}
          onSelect={(id) => {
            selectNode(id);
            centerOn(nodesById.get(id));
          }}
        />
      )}

      {menu && (
        <ContextMenu
          state={menu}
          onClose={() => setMenu(null)}
          onOpenSource={(node) => {
            if (node.sourceUrl) window.open(node.sourceUrl, '_blank', 'noopener');
          }}
          onCopyLink={(node) => {
            if (node.sourceUrl) void navigator.clipboard?.writeText(node.sourceUrl);
          }}
          onExpand={(node) => void focusEgo(node.id)}
          onDelete={(node) => void handleDelete([node.id])}
        />
      )}
    </div>
  );
}

const shell: CSSProperties = {
  position: 'relative',
  width: '100%',
  height: '100%',
  overflow: 'hidden',
  background: '#0b0f1a',
};
const toolbar: CSSProperties = {
  position: 'absolute',
  top: 12,
  left: '50%',
  transform: 'translateX(-50%)',
  display: 'flex',
  gap: 8,
  alignItems: 'center',
  zIndex: 4,
};
const searchInput: CSSProperties = {
  width: 260,
  borderRadius: 12,
  border: '1px solid #26304d',
  background: 'rgba(13,19,36,0.95)',
  color: '#e8edf6',
  padding: '0.6rem 0.8rem',
  outline: 'none',
};
const resultsList: CSSProperties = {
  position: 'absolute',
  top: 'calc(100% + 6px)',
  left: 0,
  right: 0,
  listStyle: 'none',
  margin: 0,
  padding: 4,
  background: 'rgba(17,23,42,0.98)',
  border: '1px solid #26304d',
  borderRadius: 10,
  boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
  maxHeight: 280,
  overflowY: 'auto',
};
const resultBtn: CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'center',
  width: '100%',
  textAlign: 'left',
  background: 'transparent',
  border: 'none',
  color: '#dce5ff',
  padding: '0.45rem 0.55rem',
  borderRadius: 7,
  cursor: 'pointer',
  fontSize: '0.84rem',
};
const swatch: CSSProperties = { width: 10, height: 10, borderRadius: 3, flex: '0 0 auto' };
const toolBtn: CSSProperties = {
  borderRadius: 12,
  border: '1px solid #26304d',
  background: 'rgba(18,26,46,0.95)',
  color: '#dce5ff',
  padding: '0.6rem 0.85rem',
  fontWeight: 600,
  cursor: 'pointer',
  fontSize: '0.84rem',
};
const countPill: CSSProperties = {
  borderRadius: 999,
  border: '1px solid #1f2740',
  background: 'rgba(13,19,36,0.9)',
  color: '#9caad0',
  padding: '0.45rem 0.7rem',
  fontSize: '0.78rem',
  whiteSpace: 'nowrap',
};
const focusBanner: CSSProperties = {
  position: 'absolute',
  bottom: 14,
  left: '50%',
  transform: 'translateX(-50%)',
  display: 'flex',
  gap: 12,
  alignItems: 'center',
  background: 'rgba(17,23,42,0.96)',
  border: '1px solid #2a3550',
  borderRadius: 999,
  padding: '0.5rem 0.9rem',
  color: '#dce5ff',
  fontSize: '0.84rem',
  zIndex: 4,
};
const exitFocusBtn: CSSProperties = {
  borderRadius: 999,
  border: '1px solid #26304d',
  background: '#121a2e',
  color: '#dce5ff',
  padding: '0.3rem 0.7rem',
  cursor: 'pointer',
  fontSize: '0.8rem',
};
const noticeToast: CSSProperties = {
  position: 'absolute',
  bottom: 14,
  right: 14,
  background: 'rgba(15,23,19,0.96)',
  border: '1px solid #1e3a2b',
  color: '#9df1b5',
  borderRadius: 12,
  padding: '0.6rem 0.9rem',
  fontSize: '0.84rem',
  zIndex: 6,
};
const overlay: CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  textAlign: 'center',
  padding: 24,
  color: '#aab3cc',
  background: 'rgba(11,15,26,0.6)',
  zIndex: 8,
};
