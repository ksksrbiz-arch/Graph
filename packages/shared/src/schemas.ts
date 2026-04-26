// zod schemas — runtime validators that mirror types.ts. Used at every system
// boundary (API request bodies, connector outputs, env vars). See spec §5.2.
//
// NB: prefer `KGNodeSchema.parse` over manual checks. Don't `as` cast unknown
// inputs; that defeats the point of having a runtime validator.

import { z } from 'zod';
import {
  CONNECTOR_IDS,
  EDGE_RELATIONS,
  NODE_TYPES,
  type ConnectorId,
  type EdgeRelation,
  type KGEdge,
  type KGNode,
  type NodeType,
} from './types.js';

const isoDateString = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: 'expected ISO-8601 timestamp' });

export const NodeTypeSchema = z.enum(NODE_TYPES) satisfies z.ZodType<NodeType>;
export const EdgeRelationSchema = z.enum(EDGE_RELATIONS) satisfies z.ZodType<EdgeRelation>;
export const ConnectorIdSchema = z.enum(CONNECTOR_IDS) satisfies z.ZodType<ConnectorId>;

export const KGNodeSchema: z.ZodType<KGNode> = z.object({
  id: z.string().uuid(),
  label: z.string().min(1).max(2000),
  type: NodeTypeSchema,
  createdAt: isoDateString,
  updatedAt: isoDateString,
  metadata: z.record(z.string(), z.unknown()),
  sourceId: ConnectorIdSchema,
  sourceUrl: z.string().url().optional(),
  embedding: z.array(z.number()).length(384).optional(),
  deletedAt: isoDateString.optional(),
});

export const KGEdgeSchema: z.ZodType<KGEdge> = z.object({
  id: z.string().uuid(),
  source: z.string(),
  target: z.string(),
  relation: EdgeRelationSchema,
  weight: z.number().min(0).max(1),
  inferred: z.boolean(),
  createdAt: isoDateString,
  metadata: z.record(z.string(), z.unknown()),
});

export const EncryptedCredentialsSchema = z.object({
  ciphertext: z.string().min(1),
  iv: z.string().min(1),
  keyId: z.string().min(1),
});

export const ConnectorConfigSchema = z.object({
  id: ConnectorIdSchema,
  userId: z.string().uuid(),
  enabled: z.boolean(),
  credentials: EncryptedCredentialsSchema,
  syncIntervalMinutes: z.number().int().min(1).max(60 * 24),
  lastSyncAt: isoDateString.optional(),
  lastSyncStatus: z.enum(['success', 'partial', 'failed']).optional(),
  rateLimitRemaining: z.number().int().nonnegative().optional(),
  rateLimitResetsAt: isoDateString.optional(),
});

export const GraphFilterSchema = z.object({
  nodeTypes: z.array(NodeTypeSchema),
  connectorIds: z.array(ConnectorIdSchema),
  dateRange: z
    .object({ from: isoDateString, to: isoDateString })
    .optional(),
  searchQuery: z.string().max(500).optional(),
  minEdgeWeight: z.number().min(0).max(1).optional(),
});

export const SubgraphSchema = z.object({
  nodes: z.array(KGNodeSchema),
  edges: z.array(KGEdgeSchema),
});

// ── env-var schema (Rule 5: validate at startup) ─────────────
export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  API_HOST: z.string().default('0.0.0.0'),

  POSTGRES_URL: z.string().url(),
  NEO4J_URI: z.string().min(1),
  NEO4J_USER: z.string().min(1),
  NEO4J_PASSWORD: z.string().min(1),
  REDIS_URL: z.string().url(),
  MEILI_HOST: z.string().url(),
  MEILI_MASTER_KEY: z.string().min(1),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be ≥32 bytes'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).default(900),
  JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().min(3600).default(2_592_000),

  KEK_BASE64: z
    .string()
    .refine((s) => Buffer.from(s, 'base64').length === 32, {
      message: 'KEK_BASE64 must decode to exactly 32 bytes (AES-256)',
    }),

  // ── OAuth provider credentials (optional; required only when the connector
  // ── is enabled and a user starts the connect flow). ─────────────────────
  GITHUB_OAUTH_CLIENT_ID: z.string().optional(),
  GITHUB_OAUTH_CLIENT_SECRET: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_OAUTH_CLIENT_ID: z.string().optional(),
  MICROSOFT_OAUTH_CLIENT_SECRET: z.string().optional(),
  NOTION_OAUTH_CLIENT_ID: z.string().optional(),
  NOTION_OAUTH_CLIENT_SECRET: z.string().optional(),
  TODOIST_OAUTH_CLIENT_ID: z.string().optional(),
  TODOIST_OAUTH_CLIENT_SECRET: z.string().optional(),
  LINEAR_OAUTH_CLIENT_ID: z.string().optional(),
  LINEAR_OAUTH_CLIENT_SECRET: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;
