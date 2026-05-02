// Type contracts mirroring §5 of the v2.0 spec. Edit the spec and this file
// together — drifting them is a high-priority bug.

// ── Node ───────────────────────────────────────────────────────
export interface KGNode {
  /** UUID v4 */
  id: string;
  /** Human-readable title */
  label: string;
  /** Taxonomy type */
  type: NodeType;
  /** ISO-8601 timestamp of source creation */
  createdAt: string;
  /** ISO-8601 timestamp of last sync */
  updatedAt: string;
  /** Arbitrary key-value metadata from source connector */
  metadata: Record<string, unknown>;
  /** Source connector identifier */
  sourceId: ConnectorId;
  /** Original source URL or deep-link */
  sourceUrl?: string;
  /** Pre-computed embedding vector (384 dimensions) for semantic search */
  embedding?: number[];
  /** Soft-delete flag */
  deletedAt?: string;
}

export const NODE_TYPES = [
  'person',
  'document',
  'email',
  'event',
  'task',
  'repository',
  'commit',
  'issue',
  'pull_request',
  'bookmark',
  'note',
  'concept',
  'vendor',
  'bill',
  'payment_proposal',
  'tax_liability',
  'compliance_rule',
  'approval_event',
  'revenue_inflow',
  'client',
  'contract',
  'tax_classification',
  'deposit_proposal',
  'reconciliation_event',
] as const;

export type NodeType = (typeof NODE_TYPES)[number];

// ── Edge ───────────────────────────────────────────────────────
export interface KGEdge {
  /** UUID v4 */
  id: string;
  /** Source node id */
  source: string;
  /** Target node id */
  target: string;
  /** Relationship type (Cypher-style ALL_CAPS) */
  relation: EdgeRelation;
  /** 0–1 weight for layout force calculations */
  weight: number;
  /** Whether this edge was inferred by NLP (vs. explicit) */
  inferred: boolean;
  /** ISO-8601 timestamp */
  createdAt: string;
  metadata: Record<string, unknown>;
}

export const EDGE_RELATIONS = [
  'MENTIONS',
  'AUTHORED_BY',
  'ASSIGNED_TO',
  'RELATED_TO',
  'PART_OF',
  'LINKS_TO',
  'REPLIED_TO',
  'TAGGED_WITH',
  'SCHEDULED_WITH',
  'COMMITS_TO',
  'CLOSES',
  'REFERENCES',
  'BILLED_TO',
  'CLASSIFIED_AS',
  'FUNDS',
  'PROPOSES',
  'RECONCILES',
] as const;

export type EdgeRelation = (typeof EDGE_RELATIONS)[number];

// ── Connector ──────────────────────────────────────────────────
export const CONNECTOR_IDS = [
  'gmail',
  'outlook_mail',
  'slack',
  'discord',
  'microsoft_teams',
  'telegram',
  'whatsapp_business',
  'intercom',
  'zendesk',
  'help_scout',
  'notion',
  'obsidian',
  'roam',
  'confluence',
  'coda',
  'airtable',
  'google_drive',
  'dropbox',
  'onedrive',
  'box',
  'github',
  'gitlab',
  'bitbucket',
  'google_calendar',
  'outlook_calendar',
  'calendly',
  'todoist',
  'google_tasks',
  'linear',
  'jira',
  'asana',
  'trello',
  'clickup',
  'monday',
  'figma',
  'miro',
  'bookmarks',
  'zotero',
  'evernote',
  'web_clip',
  'hubspot',
  'salesforce',
  'pipedrive',
  'stripe',
  'quickbooks',
  'shopify',
  'x_twitter',
  'linkedin',
  'reddit',
  'youtube',
  'spotify',
  'pocket',
  'instapaper',
  'raindrop',
  'openai',
  'anthropic',
  'perplexity',
  'gemini',
  'huggingface',
  'pieces',
] as const;

export type ConnectorId = (typeof CONNECTOR_IDS)[number];
export const DEFAULT_CONNECTOR_SYNC_INTERVAL_MINUTES = 30;

export interface EncryptedCredentials {
  /** AES-256-GCM encrypted token blob (base64) */
  ciphertext: string;
  /** 96-bit IV (base64) */
  iv: string;
  /** Key ID from KEK store */
  keyId: string;
}

export type SyncStatus = 'success' | 'partial' | 'failed';

export interface ConnectorConfig {
  id: ConnectorId;
  userId: string;
  enabled: boolean;
  credentials: EncryptedCredentials;
  syncIntervalMinutes: number;
  lastSyncAt?: string;
  lastSyncStatus?: SyncStatus;
  rateLimitRemaining?: number;
  rateLimitResetsAt?: string;
}

// ── Graph viewport state (frontend) ───────────────────────────
export interface GraphFilter {
  nodeTypes: NodeType[];
  connectorIds: ConnectorId[];
  dateRange?: { from: string; to: string };
  searchQuery?: string;
  minEdgeWeight?: number;
}

export interface GraphViewport {
  centerX: number;
  centerY: number;
  zoom: number;
  /** IDs of currently highlighted nodes */
  highlighted: string[];
  /** IDs of selected nodes */
  selected: string[];
  /** Active filter set */
  filters: GraphFilter;
}

// ── Subgraph payload (API §6) ─────────────────────────────────
export interface Subgraph {
  nodes: KGNode[];
  edges: KGEdge[];
}

// ── Pagination ────────────────────────────────────────────────
export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

// ── Realtime delta (API §6.3) ────────────────────────────────
export type GraphDeltaType =
  | 'NODES_ADDED'
  | 'NODES_UPDATED'
  | 'NODES_DELETED'
  | 'EDGES_ADDED'
  | 'EDGES_DELETED';

export interface GraphDeltaEvent {
  type: GraphDeltaType;
  nodes?: KGNode[];
  edges?: KGEdge[];
  /** ISO-8601 */
  timestamp: string;
}

export interface SyncProgressEvent {
  jobId: string;
  connectorId: ConnectorId;
  processed: number;
  total: number;
  errors: string[];
}

// ── User profile ──────────────────────────────────────────────
export interface UserProfile {
  id: string;
  email: string;
  displayName?: string;
  locale: string;
  createdAt: string;
}
