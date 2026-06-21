import { useEffect, type CSSProperties } from 'react';
import type { GraphNode } from './types';

export interface ContextMenuState {
  x: number;
  y: number;
  node: GraphNode;
}

/** Right-click node menu (AC-F07): Open source, Copy link, Expand, Delete. */
export function ContextMenu({
  state,
  onClose,
  onOpenSource,
  onCopyLink,
  onExpand,
  onDelete,
}: {
  state: ContextMenuState;
  onClose: () => void;
  onOpenSource: (node: GraphNode) => void;
  onCopyLink: (node: GraphNode) => void;
  onExpand: (node: GraphNode) => void;
  onDelete: (node: GraphNode) => void;
}): JSX.Element {
  useEffect(() => {
    const close = (): void => onClose();
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [onClose]);

  const { node } = state;
  return (
    <ul style={{ ...menu, left: state.x, top: state.y }} role="menu">
      <Item label="Open source" disabled={!node.sourceUrl} onClick={() => onOpenSource(node)} />
      <Item label="Copy link" disabled={!node.sourceUrl} onClick={() => onCopyLink(node)} />
      <Item label="Expand neighbourhood" onClick={() => onExpand(node)} />
      <div style={divider} />
      <Item label="Delete node" danger onClick={() => onDelete(node)} />
    </ul>
  );
}

function Item({
  label,
  onClick,
  disabled,
  danger,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}): JSX.Element {
  return (
    <li role="menuitem">
      <button
        type="button"
        disabled={disabled}
        onClick={onClick}
        style={{
          ...itemBtn,
          color: disabled ? '#566489' : danger ? '#ffb7c4' : '#dce5ff',
          cursor: disabled ? 'not-allowed' : 'pointer',
        }}
      >
        {label}
      </button>
    </li>
  );
}

const menu: CSSProperties = {
  position: 'fixed',
  listStyle: 'none',
  margin: 0,
  padding: 4,
  minWidth: 190,
  background: 'rgba(17,23,42,0.98)',
  border: '1px solid #26304d',
  borderRadius: 10,
  boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
  zIndex: 20,
};
const itemBtn: CSSProperties = {
  width: '100%',
  textAlign: 'left',
  background: 'transparent',
  border: 'none',
  padding: '0.5rem 0.65rem',
  borderRadius: 7,
  fontSize: '0.85rem',
};
const divider: CSSProperties = { height: 1, background: '#1f2740', margin: '4px 0' };
