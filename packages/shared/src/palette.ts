// Node-type colour palette (spec §7.2 AC-F02). A 12-hue, contrast-compliant
// base palette; every NodeType maps onto one of the hues by semantic grouping
// so the canvas can colour-encode node types consistently across renderers.
//
// Kept in @pkg/shared so the v1 viewer, the Worker, and the React canvas can
// all agree on the same colours.

import { NODE_TYPES, type NodeType } from './types.js';

/** The 12 base hues. Chosen for ≥3:1 contrast against the dark canvas
 *  (#0b0f1a) and reasonable separation from one another. */
export const PALETTE_12 = [
  '#7c9cff', // 0  indigo   — knowledge / concepts
  '#50d47f', // 1  green    — code / repositories
  '#ffd45c', // 2  amber    — people / social
  '#ff7eb6', // 3  pink     — communication
  '#4dd0e1', // 4  cyan     — documents / notes
  '#b388ff', // 5  violet   — tasks / planning
  '#ffab66', // 6  orange   — events / time
  '#9ccc65', // 7  lime     — bookmarks / web
  '#ef5350', // 8  red      — issues / alerts
  '#26a69a', // 9  teal     — finance / money
  '#bdbdbd', // 10 grey     — misc / fallback
  '#f06292', // 11 magenta  — media / images
] as const;

export type PaletteColor = (typeof PALETTE_12)[number];

/** Maps every NodeType onto a base hue index. Related types share a hue. */
const NODE_TYPE_HUE: Record<NodeType, number> = {
  concept: 0,
  document: 4,
  email: 3,
  event: 6,
  task: 5,
  repository: 1,
  commit: 1,
  issue: 8,
  pull_request: 1,
  bookmark: 7,
  note: 4,
  person: 2,
  image: 11,
  code: 1,
  list_item: 5,
  vendor: 9,
  bill: 9,
  payment_proposal: 9,
  tax_liability: 9,
  compliance_rule: 8,
  approval_event: 6,
  revenue_inflow: 9,
  client: 2,
  contract: 4,
  tax_classification: 0,
  deposit_proposal: 9,
  reconciliation_event: 6,
};

/** NodeType → hex colour. */
export const NODE_TYPE_COLORS: Record<NodeType, PaletteColor> = Object.fromEntries(
  NODE_TYPES.map((type) => [type, PALETTE_12[NODE_TYPE_HUE[type]]]),
) as Record<NodeType, PaletteColor>;

const FALLBACK_COLOR = PALETTE_12[10];

/** Resolve a colour for any node type, tolerating unknown values. */
export function colorForNodeType(type: string | undefined): string {
  if (type && type in NODE_TYPE_COLORS) {
    return NODE_TYPE_COLORS[type as NodeType];
  }
  return FALLBACK_COLOR;
}
