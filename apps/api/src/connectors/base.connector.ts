// Spec §9.1 — abstract contract every connector must implement.
//
// Phase 0 freezes the shape; concrete implementations land in Phases 4–7.
// Rule 12 (idempotent syncs) and Rule 13 (rate-limit respect) are obligations
// on every concrete subclass.

import type { ConnectorConfig, ConnectorId, KGEdge, KGNode } from '@pkg/shared';

export interface RawItem {
  /** Raw payload from the source API — shape varies per connector */
  raw: unknown;
  /** Stable upstream id used for dedupe / idempotent merge */
  externalId: string;
}

export interface TransformResult {
  node: KGNode;
  edges: KGEdge[];
}

export abstract class BaseConnector {
  abstract readonly id: ConnectorId;
  abstract readonly oauthScopes: readonly string[];
  /** How this connector authenticates. 'oauth' uses the OAuth flow; 'apikey'
   *  is configured via POST /connectors/:id/configure with a plain API key. */
  readonly authType: 'oauth' | 'apikey' = 'oauth';

  /**
   * Yield raw items created or updated since `since`. Implementations MUST be
   * idempotent — the same item produced twice must result in a single
   * (node, edges) tuple in the graph (Rule 12).
   */
  abstract fetchIncremental(
    config: ConnectorConfig,
    since: Date,
  ): AsyncGenerator<RawItem>;

  /** Map a raw source item to a node + outgoing edges. Pure function. */
  abstract transform(raw: RawItem): TransformResult;
}
