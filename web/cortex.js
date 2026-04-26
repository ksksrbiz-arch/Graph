// Browser-side region tagging — mirrors @pkg/cortex. Used by the local
// fallback simulator and to colour spike pulses on the canvas.

export const REGIONS = ['sensory', 'memory', 'association', 'executive', 'motor', 'limbic'];

export const REGION_STYLES = {
  sensory:     { color: '#5dd2ff', label: 'Sensory' },
  memory:      { color: '#9b8cff', label: 'Memory' },
  association: { color: '#7c9cff', label: 'Association' },
  executive:   { color: '#ff9b6b', label: 'Executive' },
  motor:       { color: '#ff6b9d', label: 'Motor' },
  limbic:      { color: '#ffd45c', label: 'Limbic' },
};

const NODE_TYPE_TO_REGION = {
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
  // v1 schema types observed in data/graph.json:
  project: 'executive',
  conversation: 'sensory',
  model: 'association',
  message: 'sensory',
  tool_use: 'motor',
  author: 'limbic',
  file: 'memory',
};

const CONNECTOR_BIAS = {
  gmail: 'sensory',
  outlook_mail: 'sensory',
  bookmarks: 'sensory',
};

export function regionForNode(node) {
  if (node.sourceId && CONNECTOR_BIAS[node.sourceId]) return CONNECTOR_BIAS[node.sourceId];
  return NODE_TYPE_TO_REGION[node.type] ?? 'association';
}

export function styleForRegion(region) {
  return REGION_STYLES[region] ?? REGION_STYLES.association;
}
