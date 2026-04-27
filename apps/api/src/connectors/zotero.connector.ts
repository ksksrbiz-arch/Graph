// Zotero connector — fetches items from the Zotero Web API and ingests them
// as `document` KGNodes.  Each academic paper, book, report, or web-page item
// in the user's personal (or group) library becomes a node; creators become
// `person` nodes connected via AUTHORED_BY; tags become nodes connected via
// TAGGED_WITH.
//
// Authentication: Zotero uses a static API key rather than OAuth tokens.  The
// key is stored in ConnectorConfig.credentials like every other connector.
// The access token field contains the raw API key; there is no refresh cycle.
//
// Rate limits (Rule 13): Zotero sends `Backoff` and `Retry-After` headers when
// throttled.  authedFetch is configured with the `token` scheme because Zotero
// uses `Zotero-API-Key` rather than `Authorization: Bearer`.
//
// Idempotency (Rule 12): node ids are derived from the Zotero item key via
// deterministicUuid so re-syncing the same item is a no-op MERGE.
//
// Docs: https://www.zotero.org/support/dev/web_api/v3/basics

import { Injectable, Logger } from '@nestjs/common';
import type { ConnectorConfig, KGEdge, KGNode } from '@pkg/shared';
import { BaseConnector, type RawItem, type TransformResult } from './base.connector';
import {
  deterministicUuid,
  isoNow,
  newEdgeId,
} from './connector-utils';
import { OAuthService } from '../oauth/oauth.service';

interface ZoteroCreator {
  creatorType: string;
  firstName?: string;
  lastName?: string;
  name?: string;
}

interface ZoteroTag {
  tag: string;
  type?: number;
}

interface ZoteroItemData {
  key: string;
  version: number;
  itemType: string;
  title?: string;
  creators?: ZoteroCreator[];
  abstractNote?: string;
  date?: string;
  DOI?: string;
  url?: string;
  publicationTitle?: string;
  volume?: string;
  pages?: string;
  tags?: ZoteroTag[];
  collections?: string[];
  dateAdded?: string;
  dateModified?: string;
}

interface ZoteroItem {
  key: string;
  version: number;
  library: { type: string; id: number };
  data: ZoteroItemData;
}

/** Extended credential shape for Zotero — the API key is stored as
 *  `accessToken` (standard field); an optional `groupId` allows syncing a
 *  group library instead of the personal one. */
interface ZoteroCredentialBlob {
  accessToken: string;
  groupId?: string;
}

const PAGE_SIZE = 50;
const MAX_PAGES = 4; // 200 items per sync
const ZOTERO_API_VERSION = '3';

@Injectable()
export class ZoteroConnector extends BaseConnector {
  private readonly log = new Logger(ZoteroConnector.name);
  readonly id = 'zotero' as const;
  readonly oauthScopes = [] as const; // Zotero uses API keys, not OAuth scopes

  constructor(private readonly oauth: OAuthService) {
    super();
  }

  async *fetchIncremental(
    config: ConnectorConfig,
    since: Date,
  ): AsyncGenerator<RawItem> {
    const creds = this.oauth.decryptCredentials(config);
    const apiKey = creds.accessToken;

    // Determine the library path from config metadata (userId stored as
    // the connector's external user id).
    const libraryPath = this.resolveLibraryPath(config);
    // Zotero supports full version-based incremental sync; for Phase 0 we
    // use date-based filtering instead (since parameter).

    for (let page = 0; page < MAX_PAGES; page++) {
      const start = page * PAGE_SIZE;
      const url =
        `https://api.zotero.org${libraryPath}/items` +
        `?itemType=-attachment&sort=dateModified&direction=desc` +
        `&start=${start}&limit=${PAGE_SIZE}`;

      let res: Response;
      try {
        res = await fetch(url, {
          headers: {
            'Zotero-API-Key': apiKey,
            'Zotero-API-Version': ZOTERO_API_VERSION,
          },
        });
      } catch (err) {
        this.log.warn(`zotero fetch error: ${String(err)}`);
        return;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        this.log.warn(`zotero ${res.status}: ${text.slice(0, 160)}`);
        if (res.status === 429) {
          const retryAfter = res.headers.get('Retry-After') ?? res.headers.get('Backoff');
          this.log.warn(`zotero rate-limited; Retry-After: ${retryAfter ?? 'unknown'}`);
        }
        return;
      }

      const items = (await res.json()) as ZoteroItem[];
      if (!Array.isArray(items) || items.length === 0) return;

      const totalResults = Number(res.headers.get('Total-Results') ?? items.length);

      let crossedSince = false;
      for (const item of items) {
        const modified = Date.parse(item.data.dateModified ?? item.data.dateAdded ?? '');
        if (Number.isFinite(modified) && modified <= since.getTime()) {
          crossedSince = true;
          break;
        }
        yield { externalId: item.key, raw: item };
      }

      if (crossedSince || start + PAGE_SIZE >= totalResults) return;
    }
  }

  transform(raw: RawItem): TransformResult {
    const item = raw.raw as ZoteroItem;
    const data = item.data;

    const title = (data.title ?? '(untitled)').trim().slice(0, 200);
    const nodeId = deterministicUuid('zotero', item.key);

    const sourceUrl = data.url ?? (data.DOI ? `https://doi.org/${data.DOI}` : undefined);

    const node: KGNode = {
      id: nodeId,
      type: 'document',
      label: title,
      sourceId: 'zotero',
      ...(sourceUrl ? { sourceUrl } : {}),
      createdAt: data.dateAdded ?? isoNow(),
      updatedAt: data.dateModified ?? isoNow(),
      metadata: {
        itemType: data.itemType,
        abstractNote: data.abstractNote?.slice(0, 500) ?? null,
        doi: data.DOI ?? null,
        url: data.url ?? null,
        date: data.date ?? null,
        publicationTitle: data.publicationTitle ?? null,
        volume: data.volume ?? null,
        pages: data.pages ?? null,
        zoteroKey: item.key,
        zoteroVersion: item.version,
        collections: data.collections ?? [],
      },
    };

    const edges: KGEdge[] = [];

    // Creator → AUTHORED_BY edges
    for (const creator of data.creators ?? []) {
      const name = resolveCreatorName(creator);
      if (!name) continue;
      const personId = deterministicUuid('zotero', `person:${name.toLowerCase()}`);
      edges.push(
        edgeBetween(
          nodeId,
          personId,
          'AUTHORED_BY',
          creator.creatorType === 'author' ? 0.8 : 0.5,
        ),
      );
      // The person node itself is synthesised here so the sync orchestrator can
      // upsert it alongside the document.  We embed it in the edge metadata
      // rather than returning a second top-level node to preserve the current
      // single-node TransformResult contract.
      edges[edges.length - 1].metadata = {
        ...edges[edges.length - 1].metadata,
        personLabel: name,
        personId,
        creatorType: creator.creatorType,
      };
    }

    // Tag → TAGGED_WITH edges
    for (const { tag } of data.tags ?? []) {
      if (!tag?.trim()) continue;
      const tagId = deterministicUuid('zotero', `tag:${tag.trim().toLowerCase()}`);
      edges.push(edgeBetween(nodeId, tagId, 'TAGGED_WITH', 0.4));
      edges[edges.length - 1].metadata = {
        ...edges[edges.length - 1].metadata,
        tagLabel: tag.trim(),
        tagId,
      };
    }

    // Collection → PART_OF edges
    for (const collKey of data.collections ?? []) {
      const collId = deterministicUuid('zotero', `collection:${collKey}`);
      edges.push(edgeBetween(nodeId, collId, 'PART_OF', 0.5));
    }

    return { node, edges };
  }

  /** Derive the Zotero library path.  If the config carries a `groupId`
   *  metadata field it uses the group library; otherwise the personal library
   *  for the userId. */
  private resolveLibraryPath(config: ConnectorConfig): string {
    const blob = config.credentials as unknown as ZoteroCredentialBlob;
    const groupId = blob?.groupId?.trim() ?? null;
    if (groupId) return `/groups/${groupId}`;
    return `/users/${config.userId}`;
  }
}

function resolveCreatorName(creator: ZoteroCreator): string | null {
  if (creator.name?.trim()) return creator.name.trim();
  const parts = [creator.firstName, creator.lastName].filter(Boolean);
  const full = parts.join(' ').trim();
  return full || null;
}

function edgeBetween(
  source: string,
  target: string,
  relation: KGEdge['relation'],
  weight: number,
): KGEdge {
  return {
    id: newEdgeId(),
    source,
    target,
    relation,
    weight,
    inferred: false,
    createdAt: isoNow(),
    metadata: {},
  };
}
