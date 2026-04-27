// Neo4j repository — implements the Cypher patterns documented in spec §8.2.
//
// Idempotency (Rule 12): every write uses MERGE; re-running the same source
// item must not duplicate nodes/edges. Two layers cooperate to make this safe:
//
//  1. MERGE keys by (id, userId) for nodes and (id) for edges, so duplicate
//     payloads are coalesced even if they slip past layer 2.
//  2. An in-memory fingerprint cache short-circuits identical writes that
//     arrive in quick succession (e.g. when a connector reruns mid-batch).
//     The cache is bounded; eviction is FIFO.

import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Driver, Record as Neo4jRecord } from 'neo4j-driver';
import type { CursorPage, KGEdge, KGNode, NodeType, Subgraph } from '@pkg/shared';
import { NEO4J_DRIVER } from '../shared/neo4j/neo4j.module';

const FINGERPRINT_CACHE_MAX = 4_096;

@Injectable()
export class GraphRepository {
  /** (userId|kind|id) → sha256 of the last-persisted payload. Matches mean we
   *  can skip the Cypher round-trip; mismatches fall through to MERGE. */
  private readonly fingerprintCache = new Map<string, string>();

  constructor(@Inject(NEO4J_DRIVER) private readonly driver: Driver) {}

  /** Returns true if the write actually hit Neo4j; false when deduped by the
   *  in-memory fingerprint cache. */
  async upsertNode(userId: string, node: KGNode): Promise<boolean> {
    const props = this.nodeProps(node);
    const fp = fingerprint({ kind: 'node', id: node.id, userId, props });
    const cacheKey = `${userId}|node|${node.id}`;
    if (this.fingerprintCache.get(cacheKey) === fp) return false;

    const session = this.driver.session();
    try {
      await session.run(
        `MERGE (n:KGNode {id: $id, userId: $userId})
         SET n += $props, n.updatedAt = datetime()`,
        { id: node.id, userId, props },
      );
    } finally {
      await session.close();
    }
    this.rememberFingerprint(cacheKey, fp);
    return true;
  }

  async upsertEdge(userId: string, edge: KGEdge): Promise<boolean> {
    const props = this.edgeProps(edge);
    const fp = fingerprint({
      kind: 'edge',
      id: edge.id,
      userId,
      source: edge.source,
      target: edge.target,
      props,
    });
    const cacheKey = `${userId}|edge|${edge.id}`;
    if (this.fingerprintCache.get(cacheKey) === fp) return false;

    const session = this.driver.session();
    try {
      await session.run(
        `MATCH (a:KGNode {id: $source, userId: $userId})
         MATCH (b:KGNode {id: $target, userId: $userId})
         MERGE (a)-[r:REL {id: $id}]->(b)
         SET r += $props`,
        {
          source: edge.source,
          target: edge.target,
          userId,
          id: edge.id,
          props,
        },
      );
    } finally {
      await session.close();
    }
    this.rememberFingerprint(cacheKey, fp);
    return true;
  }

  /** Cursor-based page of nodes for a user. Cursor is a base64url-encoded
   *  ISO-8601 createdAt timestamp (the last item on the previous page).
   *  Returns items created strictly after the cursor, sorted by createdAt ASC,
   *  id ASC (tie-breaker). */
  async listNodes(
    userId: string,
    cursor?: string,
    limit = 100,
    type?: NodeType,
  ): Promise<CursorPage<KGNode>> {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const cursorDate = cursor ? decodeCursor(cursor) : null;

    const session = this.driver.session();
    try {
      const params: Record<string, unknown> = { userId, limit: safeLimit + 1 };
      let cypher =
        `MATCH (n:KGNode {userId: $userId})
         WHERE n.deletedAt IS NULL`;
      if (cursorDate) {
        cypher += `\n         AND n.createdAt > $cursorDate`;
        params.cursorDate = cursorDate;
      }
      if (type) {
        cypher += `\n         AND n.type = $type`;
        params.type = type;
      }
      cypher += `\n         RETURN n ORDER BY n.createdAt ASC, n.id ASC LIMIT $limit`;

      const result = await session.run(cypher, params);
      const rows = result.records;
      const hasMore = rows.length > safeLimit;
      const items = rows.slice(0, safeLimit).map((r) => this.mapNode(r.get('n')));
      const nextCursor =
        hasMore && items.length > 0
          ? encodeCursor(items[items.length - 1]!.createdAt)
          : null;
      return { items, nextCursor };
    } finally {
      await session.close();
    }
  }

  /** Fetch a single node by id scoped to the user. Returns null if not found
   *  or if the node has been soft-deleted. */
  async getNode(userId: string, nodeId: string): Promise<KGNode | null> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        `MATCH (n:KGNode {id: $nodeId, userId: $userId})
         WHERE n.deletedAt IS NULL
         RETURN n`,
        { nodeId, userId },
      );
      if (!result.records[0]) return null;
      return this.mapNode(result.records[0].get('n'));
    } finally {
      await session.close();
    }
  }

  /** Ego-network of `rootId` up to `depth` hops. Spec §8.2 query 2.
   *  `depth` is interpolated into the Cypher path pattern (parameters aren't
   *  allowed there), so we clamp to [1,4] before substitution to prevent
   *  Cypher injection or runaway traversals. */
  async subgraph(userId: string, rootId: string, depth = 2, limit = 500): Promise<Subgraph> {
    const safeDepth = Math.max(1, Math.min(4, Math.floor(depth)));
    const session = this.driver.session();
    try {
      const result = await session.run(
        `MATCH path = (root:KGNode {id: $rootId, userId: $userId})-[*1..${safeDepth}]-(neighbour:KGNode {userId: $userId})
         WITH collect(distinct neighbour) + collect(distinct root) AS ns,
              collect(distinct relationships(path)) AS rels
         RETURN ns AS nodes, apoc.coll.flatten(rels) AS edges
         LIMIT $limit`,
        { rootId, userId, limit },
      );
      const record = result.records[0];
      if (!record) return { nodes: [], edges: [] };
      return this.mapSubgraph(record);
    } finally {
      await session.close();
    }
  }

  /** Full snapshot of a user's graph — used by the public/demo ingest path
   *  so the SPA can render Neo4j-backed nodes without a full GraphQL setup.
   *  Capped by `limit` (defaults to 5k). */
  async snapshotForUser(
    userId: string,
    limit = 5_000,
  ): Promise<{ nodes: KGNode[]; edges: KGEdge[] }> {
    const session = this.driver.session();
    try {
      const nodesRes = await session.run(
        `MATCH (n:KGNode {userId: $userId})
         WHERE n.deletedAt IS NULL
         RETURN n
         LIMIT $limit`,
        { userId, limit },
      );
      const nodes = nodesRes.records.map((r) => this.mapNode(r.get('n')));

      const edgesRes = await session.run(
        `MATCH (a:KGNode {userId: $userId})-[r:REL]->(b:KGNode {userId: $userId})
         WHERE a.deletedAt IS NULL AND b.deletedAt IS NULL
         RETURN r.id AS id, a.id AS source, b.id AS target,
                r.relation AS relation, r.weight AS weight,
                r.inferred AS inferred, r.createdAt AS createdAt,
                r.metadataJson AS metadataJson
         LIMIT $limit`,
        { userId, limit: limit * 4 },
      );
      const edges = edgesRes.records.map((r) => ({
        id: r.get('id') as string,
        source: r.get('source') as string,
        target: r.get('target') as string,
        relation: r.get('relation') as KGEdge['relation'],
        weight: Number(r.get('weight') ?? 0.4),
        inferred: r.get('inferred') === true,
        createdAt: (r.get('createdAt') as string) ?? new Date().toISOString(),
        metadata: parseMetadata(r.get('metadataJson')),
      }));

      return { nodes, edges };
    } finally {
      await session.close();
    }
  }

  async deleteNode(userId: string, nodeId: string): Promise<boolean> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        `MATCH (n:KGNode {id: $nodeId, userId: $userId})
         SET n.deletedAt = toString(datetime())
         RETURN n`,
        { nodeId, userId },
      );
      // Drop any cached fingerprint for this node so a subsequent recreate-
      // with-the-same-id is treated as a fresh write rather than a no-op.
      this.fingerprintCache.delete(`${userId}|node|${nodeId}`);
      return result.records.length > 0;
    } finally {
      await session.close();
    }
  }

  /** GDPR delete (Rule 19): purge every node + edge belonging to a user. */
  async deleteAllForUser(userId: string): Promise<void> {
    const session = this.driver.session();
    try {
      await session.run(
        `MATCH (n:KGNode {userId: $userId}) DETACH DELETE n`,
        { userId },
      );
    } finally {
      await session.close();
    }
    // Purge cached fingerprints so a re-import after delete is not skipped.
    const prefix = `${userId}|`;
    for (const k of this.fingerprintCache.keys()) {
      if (k.startsWith(prefix)) this.fingerprintCache.delete(k);
    }
  }

  // ── private helpers ──
  private nodeProps(node: KGNode): Record<string, unknown> {
    return {
      id: node.id,
      label: node.label,
      type: node.type,
      sourceId: node.sourceId,
      sourceUrl: node.sourceUrl ?? null,
      createdAt: node.createdAt,
      metadataJson: JSON.stringify(node.metadata ?? {}),
    };
  }

  private edgeProps(edge: KGEdge): Record<string, unknown> {
    return {
      id: edge.id,
      relation: edge.relation,
      weight: edge.weight,
      inferred: edge.inferred,
      createdAt: edge.createdAt,
      metadataJson: JSON.stringify(edge.metadata ?? {}),
    };
  }

  private mapSubgraph(record: Neo4jRecord): Subgraph {
    // TODO(phase-2): map Neo4j record fields back into KGNode/KGEdge with full
    // schema validation. Stubbed to keep Phase 0 lightweight.
    return {
      nodes: (record.get('nodes') ?? []) as KGNode[],
      edges: (record.get('edges') ?? []) as KGEdge[],
    };
  }

  /** Reshape a raw Neo4j node record into a KGNode. The metadata column is
   *  stored as JSON-encoded string to keep the schema flexible. */
  private mapNode(raw: { properties: Record<string, unknown> }): KGNode {
    const p = raw.properties;
    return {
      id: String(p.id),
      label: String(p.label ?? p.id),
      type: p.type as KGNode['type'],
      sourceId: p.sourceId as KGNode['sourceId'],
      sourceUrl: typeof p.sourceUrl === 'string' ? p.sourceUrl : undefined,
      createdAt: typeof p.createdAt === 'string' ? p.createdAt : new Date().toISOString(),
      updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : new Date().toISOString(),
      metadata: parseMetadata(p.metadataJson),
    };
  }

  private rememberFingerprint(key: string, fp: string): void {
    this.fingerprintCache.set(key, fp);
    if (this.fingerprintCache.size > FINGERPRINT_CACHE_MAX) {
      // FIFO eviction — the first inserted key is the oldest because Map
      // preserves insertion order.
      const oldest = this.fingerprintCache.keys().next().value;
      if (oldest !== undefined) this.fingerprintCache.delete(oldest);
    }
  }
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || value.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

// ── cursor helpers ────────────────────────────────────────────────────────────

function encodeCursor(createdAt: string): string {
  return Buffer.from(createdAt, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): string | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    if (isNaN(Date.parse(decoded))) return null;
    return decoded;
  } catch {
    return null;
  }
}
