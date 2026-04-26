// Notion connector — fetches pages the user's integration was granted access
// to via Notion's `/v1/search` endpoint, ordered by last_edited_time desc.
// Each page becomes a `note` KGNode; nested page links (LINKS_TO) are
// inferred from `parent` relationships.
//
// The Notion API does not expose attendees / authors uniformly enough to map
// reliably onto `person` nodes, so we keep this connector lean — Phase 2 NLP
// pass can mine the page body for mentions and back-fill those edges.
//
// Docs: https://developers.notion.com/reference/post-search

import { Injectable, Logger } from '@nestjs/common';
import type { ConnectorConfig, KGEdge, KGNode } from '@pkg/shared';
import { BaseConnector, type RawItem, type TransformResult } from './base.connector';
import {
  authedFetch,
  deterministicUuid,
  isoNow,
  newEdgeId,
} from './connector-utils';
import { OAuthService } from '../oauth/oauth.service';

interface NotionPage {
  object: 'page' | 'database';
  id: string;
  url?: string;
  created_time: string;
  last_edited_time: string;
  archived?: boolean;
  parent?:
    | { type: 'page_id'; page_id: string }
    | { type: 'database_id'; database_id: string }
    | { type: 'workspace'; workspace: true };
  properties?: Record<string, unknown>;
}

const PAGE_SIZE = 50;
const MAX_PAGES = 4;
const NOTION_VERSION = '2022-06-28';

@Injectable()
export class NotionConnector extends BaseConnector {
  private readonly log = new Logger(NotionConnector.name);
  readonly id = 'notion' as const;
  readonly oauthScopes = [] as const;

  constructor(private readonly oauth: OAuthService) {
    super();
  }

  async *fetchIncremental(
    config: ConnectorConfig,
    since: Date,
  ): AsyncGenerator<RawItem> {
    const creds = this.oauth.decryptCredentials(config);
    let cursor: string | undefined;

    for (let page = 0; page < MAX_PAGES; page++) {
      const body = {
        page_size: PAGE_SIZE,
        sort: { direction: 'descending', timestamp: 'last_edited_time' },
        filter: { value: 'page', property: 'object' },
        ...(cursor ? { start_cursor: cursor } : {}),
      };
      const { res } = await authedFetch(
        'https://api.notion.com/v1/search',
        creds.accessToken,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'notion-version': NOTION_VERSION,
          },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        this.log.warn(`notion search ${res.status}: ${text.slice(0, 160)}`);
        return;
      }
      const json = (await res.json()) as {
        results?: NotionPage[];
        has_more?: boolean;
        next_cursor?: string;
      };
      const items = json.results ?? [];
      let crossedSince = false;
      for (const p of items) {
        if (Date.parse(p.last_edited_time) <= since.getTime()) {
          crossedSince = true;
          break;
        }
        yield { externalId: p.id, raw: p };
      }
      if (crossedSince || !json.has_more || !json.next_cursor) return;
      cursor = json.next_cursor;
    }
  }

  transform(raw: RawItem): TransformResult {
    const p = raw.raw as NotionPage;
    const title = extractTitle(p) ?? '(untitled page)';
    const node: KGNode = {
      id: deterministicUuid('notion', p.id),
      type: 'note',
      label: title.slice(0, 200),
      sourceId: 'notion',
      ...(p.url ? { sourceUrl: p.url } : {}),
      createdAt: p.created_time,
      updatedAt: p.last_edited_time,
      metadata: {
        object: p.object,
        archived: p.archived ?? false,
        parentType: p.parent?.type ?? null,
      },
    };

    const edges: KGEdge[] = [];
    if (p.parent?.type === 'page_id') {
      edges.push(
        edgeBetween(
          node.id,
          deterministicUuid('notion', p.parent.page_id),
          'PART_OF',
          0.6,
        ),
      );
    } else if (p.parent?.type === 'database_id') {
      edges.push(
        edgeBetween(
          node.id,
          deterministicUuid('notion', `db:${p.parent.database_id}`),
          'PART_OF',
          0.5,
        ),
      );
    }
    return { node, edges };
  }
}

function extractTitle(p: NotionPage): string | null {
  // Notion's title lives somewhere different on every page depending on
  // schema. We inspect each property for the first `title` array and
  // concatenate its plain_text segments.
  const props = p.properties ?? {};
  for (const value of Object.values(props)) {
    if (
      value &&
      typeof value === 'object' &&
      'title' in (value as Record<string, unknown>)
    ) {
      const arr = (value as { title?: Array<{ plain_text?: string }> }).title;
      if (Array.isArray(arr)) {
        const text = arr
          .map((t) => t.plain_text ?? '')
          .join('')
          .trim();
        if (text) return text;
      }
    }
  }
  return null;
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
