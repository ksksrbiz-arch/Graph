import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { colorForNodeType } from '@pkg/shared';

/** A discrete action surfaced in the palette. */
export interface PaletteCommand {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

/** A node surfaced in the palette so the user can jump to it. */
export interface PaletteNode {
  id: string;
  label: string;
  type: string;
}

const RECENTS_KEY = 'graph.commandPalette.recents';
const MAX_RECENTS = 8;
const MAX_NODE_RESULTS = 50;

/** Read the persisted recent-command id list, newest first. */
function loadRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string').slice(0, MAX_RECENTS);
  } catch {
    return [];
  }
}

/** Persist `id` as the most recent command, de-duplicated and capped. */
function pushRecent(id: string): void {
  try {
    const next = [id, ...loadRecents().filter((x) => x !== id)].slice(0, MAX_RECENTS);
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    // localStorage may be unavailable (private mode, quota) — recents are best-effort.
  }
}

/** True when `query` matches `text` as a case-insensitive ordered subsequence. */
function fuzzyMatch(query: string, text: string): boolean {
  if (query === '') return true;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  // Fast path: contiguous substring.
  if (t.includes(q)) return true;
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti += 1) {
    if (t[ti] === q[qi]) qi += 1;
  }
  return qi === q.length;
}

/**
 * Registers the global Cmd/Ctrl+K toggle and exposes the palette open state.
 * Self-contained so a coordinator can wire it without owning the keybinding.
 */
export function useCommandPalette(): {
  open: boolean;
  openPalette: () => void;
  closePalette: () => void;
} {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const openPalette = useCallback(() => setOpen(true), []);
  const closePalette = useCallback(() => setOpen(false), []);
  return { open, openPalette, closePalette };
}

type Entry =
  | { kind: 'command'; command: PaletteCommand }
  | { kind: 'node'; node: PaletteNode };

export function CommandPalette({
  open,
  onClose,
  commands,
  nodes,
  onSelectNode,
}: {
  open: boolean;
  onClose: () => void;
  commands: PaletteCommand[];
  nodes: PaletteNode[];
  onSelectNode: (id: string) => void;
}): JSX.Element | null {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  // Reset transient state every time the palette opens.
  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      // Focus after paint so the modal is mounted.
      const id = window.requestAnimationFrame(() => inputRef.current?.focus());
      return () => window.cancelAnimationFrame(id);
    }
    return undefined;
  }, [open]);

  const entries = useMemo<Entry[]>(() => {
    const q = query.trim();
    const out: Entry[] = [];

    if (q === '') {
      // Surface recents first, then the rest of the commands in order.
      const recents = loadRecents();
      const byId = new Map(commands.map((c) => [c.id, c]));
      const seen = new Set<string>();
      for (const id of recents) {
        const cmd = byId.get(id);
        if (cmd) {
          out.push({ kind: 'command', command: cmd });
          seen.add(id);
        }
      }
      for (const cmd of commands) {
        if (!seen.has(cmd.id)) out.push({ kind: 'command', command: cmd });
      }
      return out;
    }

    for (const cmd of commands) {
      if (fuzzyMatch(q, cmd.label) || (cmd.hint != null && fuzzyMatch(q, cmd.hint))) {
        out.push({ kind: 'command', command: cmd });
      }
    }
    let nodeCount = 0;
    for (const node of nodes) {
      if (nodeCount >= MAX_NODE_RESULTS) break;
      if (fuzzyMatch(q, node.label) || fuzzyMatch(q, node.type)) {
        out.push({ kind: 'node', node });
        nodeCount += 1;
      }
    }
    return out;
  }, [query, commands, nodes]);

  // Keep the active index in range as the result set changes.
  useEffect(() => {
    setActive((a) => (entries.length === 0 ? 0 : Math.min(a, entries.length - 1)));
  }, [entries.length]);

  const choose = useCallback(
    (entry: Entry | undefined) => {
      if (!entry) return;
      if (entry.kind === 'command') {
        pushRecent(entry.command.id);
        onClose();
        entry.command.run();
      } else {
        onClose();
        onSelectNode(entry.node.id);
      }
    },
    [onClose, onSelectNode],
  );

  function onKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => (entries.length === 0 ? 0 : (a + 1) % entries.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (entries.length === 0 ? 0 : (a - 1 + entries.length) % entries.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(entries[active]);
    }
  }

  // Scroll the active row into view as it moves.
  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    if (!list) return;
    const el = list.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  if (!open) return null;

  return (
    <div style={backdrop} onClick={onClose}>
      <div
        style={modal}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="Search commands and nodes…"
          aria-label="Search commands and nodes"
          style={searchInput}
        />
        <ul ref={listRef} style={resultsList} role="listbox">
          {entries.map((entry, i) => {
            const selected = i === active;
            const rowStyle: CSSProperties = {
              ...resultBtn,
              background: selected ? 'rgba(124,156,255,0.16)' : 'transparent',
            };
            if (entry.kind === 'command') {
              const { command } = entry;
              return (
                <li key={`c:${command.id}`} role="option" aria-selected={selected}>
                  <button
                    type="button"
                    style={rowStyle}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => choose(entry)}
                  >
                    <span style={{ ...swatch, background: '#7c9cff' }} />
                    <span style={{ flex: 1, wordBreak: 'break-word' }}>{command.label}</span>
                    {command.hint != null && <span style={hintText}>{command.hint}</span>}
                  </button>
                </li>
              );
            }
            const { node } = entry;
            return (
              <li key={`n:${node.id}`} role="option" aria-selected={selected}>
                <button
                  type="button"
                  style={rowStyle}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(entry)}
                  title={node.id}
                >
                  <span style={{ ...swatch, background: colorForNodeType(node.type) }} />
                  <span style={{ flex: 1, wordBreak: 'break-word' }}>{node.label}</span>
                  <span style={hintText}>{node.type}</span>
                </button>
              </li>
            );
          })}
          {entries.length === 0 && <li style={emptyRow}>No matches.</li>}
        </ul>
        <div style={footer}>
          <span>
            <kbd style={kbd}>↑</kbd>
            <kbd style={kbd}>↓</kbd> navigate
          </span>
          <span>
            <kbd style={kbd}>↵</kbd> select
          </span>
          <span>
            <kbd style={kbd}>esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}

const backdrop: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(4,7,14,0.6)',
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'center',
  paddingTop: '12vh',
  zIndex: 40,
};
const modal: CSSProperties = {
  width: 'min(560px, 92vw)',
  maxHeight: '70vh',
  display: 'flex',
  flexDirection: 'column',
  background: 'rgba(17,23,42,0.98)',
  border: '1px solid #26304d',
  borderRadius: 16,
  padding: '0.8rem',
  boxShadow: '0 30px 90px rgba(0,0,0,0.6)',
  color: '#e8edf6',
};
const searchInput: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  borderRadius: 12,
  border: '1px solid #26304d',
  background: 'rgba(13,19,36,0.95)',
  color: '#e8edf6',
  padding: '0.7rem 0.85rem',
  fontSize: '0.95rem',
  outline: 'none',
};
const resultsList: CSSProperties = {
  listStyle: 'none',
  margin: '8px 0 0',
  padding: 4,
  overflowY: 'auto',
  flex: 1,
};
const resultBtn: CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'center',
  width: '100%',
  textAlign: 'left',
  border: 'none',
  color: '#dce5ff',
  padding: '0.5rem 0.6rem',
  borderRadius: 8,
  cursor: 'pointer',
  fontSize: '0.86rem',
};
const swatch: CSSProperties = { width: 10, height: 10, borderRadius: 3, flex: '0 0 auto' };
const hintText: CSSProperties = {
  color: '#7b86a3',
  fontSize: '0.74rem',
  flex: '0 0 auto',
  whiteSpace: 'nowrap',
};
const emptyRow: CSSProperties = {
  color: '#7b86a3',
  fontSize: '0.86rem',
  padding: '0.6rem',
};
const footer: CSSProperties = {
  display: 'flex',
  gap: 16,
  marginTop: 8,
  padding: '0.4rem 0.2rem 0',
  borderTop: '1px solid #1f2740',
  color: '#7b86a3',
  fontSize: '0.74rem',
};
const kbd: CSSProperties = {
  display: 'inline-block',
  background: '#0d1324',
  border: '1px solid #26304d',
  borderRadius: 5,
  padding: '0 5px',
  margin: '0 2px',
  fontSize: '0.72rem',
  color: '#aab3cc',
};
