// Functional region taxonomy. Each KG node type is assigned to one region by
// the rule below. The mapping is intentionally simple — the goal is to give
// the spiking layer a coarse functional partition for visualisation and for
// region-aware drives (e.g. inject Poisson noise only into "sensory" inputs).

import type { ConnectorId, NodeType } from '@pkg/shared';

export const REGIONS = [
  'sensory',
  'memory',
  'association',
  'executive',
  'motor',
  'limbic',
] as const;

export type Region = (typeof REGIONS)[number];

export interface RegionStyle {
  /** CSS-friendly hex colour, used by the web canvas. */
  color: string;
  /** Short human label. */
  label: string;
  /** One-sentence description of the region's role. */
  description: string;
}

export const REGION_STYLES: Record<Region, RegionStyle> = {
  sensory: {
    color: '#5dd2ff',
    label: 'Sensory',
    description: 'Inbound information channels — fresh stimuli enter here.',
  },
  memory: {
    color: '#9b8cff',
    label: 'Memory',
    description: 'Long-form notes, documents, and bookmarked references.',
  },
  association: {
    color: '#7c9cff',
    label: 'Association',
    description: 'Cross-modal links, concepts, and inferred relationships.',
  },
  executive: {
    color: '#ff9b6b',
    label: 'Executive',
    description: 'Tasks, planning artefacts, and pull-request reviews.',
  },
  motor: {
    color: '#ff6b9d',
    label: 'Motor',
    description: 'Outbound actions — commits, deploys, scheduled events.',
  },
  limbic: {
    color: '#ffd45c',
    label: 'Limbic',
    description: 'Social signals — people, mentions, replies.',
  },
};

const NODE_TYPE_TO_REGION: Record<NodeType, Region> = {
  email: 'sensory',
  bookmark: 'sensory',
  note: 'memory',
  document: 'memory',
  concept: 'association',
  issue: 'association',
  pull_request: 'executive',
  task: 'executive',
  commit: 'motor',
  event: 'motor',
  repository: 'association',
  person: 'limbic',
};

const CONNECTOR_BIAS: Partial<Record<ConnectorId, Region>> = {
  // Inbound message-style connectors lean sensory regardless of node type.
  gmail: 'sensory',
  outlook_mail: 'sensory',
  bookmarks: 'sensory',
};

export function regionForNodeType(type: NodeType): Region {
  return NODE_TYPE_TO_REGION[type]!;
}

/**
 * Resolve a region tag for a node. Connector identity can override the
 * type-based default — e.g. a `note` syncing in from gmail is treated as
 * sensory rather than memory.
 */
export function regionForNode(input: {
  type: NodeType;
  sourceId?: ConnectorId;
}): Region {
  const fromConnector =
    input.sourceId !== undefined ? CONNECTOR_BIAS[input.sourceId] : undefined;
  return fromConnector ?? regionForNodeType(input.type);
}

export function styleForRegion(region: Region): RegionStyle {
  return REGION_STYLES[region];
}
