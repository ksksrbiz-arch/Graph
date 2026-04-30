// SearchService — wraps Meilisearch operations for KGNode documents.
//
// Index layout (one index per user): `nodes_<userId>`
// Each document contains a subset of node fields that are safe to fulltext-
// index; the embedding vector is intentionally excluded from the index.
//
// Methods:
//   indexNode(userId, node)   — upsert one node document
//   deleteNode(userId, id)    — remove a document from the index
//   search(userId, q, limit)  — fulltext query → matching node ids + labels

import { Inject, Injectable, Logger } from '@nestjs/common';
import type MeiliSearch from 'meilisearch';
import type { KGNode } from '@pkg/shared';
import { MEILI_CLIENT } from './meilisearch.module';

export interface SearchHit {
  id: string;
  label: string;
  type: string;
  sourceId: string;
  sourceUrl?: string;
  createdAt: string;
}

const SEARCHABLE_ATTRS = ['label', 'type', 'sourceId'] as const;
const FILTERABLE_ATTRS = ['userId', 'type', 'sourceId', 'deletedAt'] as const;

@Injectable()
export class SearchService {
  private readonly log = new Logger(SearchService.name);

  constructor(@Inject(MEILI_CLIENT) private readonly client: MeiliSearch) {}

  /** Upsert a node document into the user-scoped search index. */
  async indexNode(userId: string, node: KGNode): Promise<void> {
    if (node.deletedAt) {
      await this.deleteNode(userId, node.id);
      return;
    }
    try {
      const index = await this.ensureIndex(userId);
      await index.addDocuments([this.toDocument(userId, node)], { primaryKey: 'id' });
    } catch (err) {
      this.log.warn(`Meilisearch indexNode failed (${node.id}): ${(err as Error).message}`);
    }
  }

  /** Remove a node document from the user-scoped search index. */
  async deleteNode(userId: string, nodeId: string): Promise<void> {
    try {
      const index = this.client.index(indexName(userId));
      await index.deleteDocument(nodeId);
    } catch (err) {
      this.log.warn(`Meilisearch deleteNode failed (${nodeId}): ${(err as Error).message}`);
    }
  }

  /** Full-text search over nodes belonging to `userId`. */
  async search(userId: string, q: string, limit = 20): Promise<SearchHit[]> {
    try {
      const index = this.client.index(indexName(userId));
      const result = await index.search<SearchHit>(q, {
        limit: Math.min(limit, 100),
        filter: 'deletedAt NOT EXISTS',
      });
      return result.hits;
    } catch (err) {
      this.log.warn(`Meilisearch search failed: ${(err as Error).message}`);
      return [];
    }
  }

  // ── private helpers ──────────────────────────────────────────────────────

  private async ensureIndex(userId: string): Promise<ReturnType<MeiliSearch['index']>> {
    const name = indexName(userId);
    try {
      await this.client.createIndex(name, { primaryKey: 'id' });
      const index = this.client.index(name);
      await index.updateSearchableAttributes([...SEARCHABLE_ATTRS]);
      await index.updateFilterableAttributes([...FILTERABLE_ATTRS]);
    } catch {
      // Index likely already exists; ignore creation errors.
    }
    return this.client.index(name);
  }

  private toDocument(userId: string, node: KGNode): Record<string, unknown> {
    return {
      id: node.id,
      userId,
      label: node.label,
      type: node.type,
      sourceId: node.sourceId,
      sourceUrl: node.sourceUrl ?? null,
      createdAt: node.createdAt,
      ...(node.deletedAt ? { deletedAt: node.deletedAt } : {}),
    };
  }
}

function indexName(userId: string): string {
  // Replace characters that Meilisearch index names don't allow with underscores.
  return `nodes_${userId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}
