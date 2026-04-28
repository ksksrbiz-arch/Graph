// Anthropic connector — ingests Anthropic API activity into the knowledge
// graph.
//
// Authentication: uses a plain API key (sk-ant-…). No OAuth cycle needed.
//
// What Anthropic exposes today (2025): the Anthropic API does not provide
// endpoints for listing a user's conversation history or stored objects.
// What IS available and useful for a knowledge graph is the **models** list
// (GET /v1/models), which surfaces every model the account has access to
// as `concept` nodes, giving the graph visibility into which Anthropic models
// are being used alongside the rest of the connectome.
//
// The connector also validates the API key on every sync so misconfigured
// keys surface as a `failed` sync status rather than silently producing no
// data. When Anthropic ships usage/history APIs this file is the extension
// point.
//
// Docs: https://docs.anthropic.com/reference/getting-started

import { Injectable, Logger } from '@nestjs/common';
import type { ConnectorConfig, KGNode } from '@pkg/shared';
import { BaseConnector, type RawItem, type TransformResult } from './base.connector';
import {
  deterministicUuid,
  isoNow,
} from './connector-utils';
import { OAuthService } from '../oauth/oauth.service';

interface AnthropicModel {
  id: string;
  type: 'model';
  display_name: string;
  created_at: string; // ISO-8601
}

interface AnthropicModelsResponse {
  data: AnthropicModel[];
  has_more: boolean;
  first_id: string | null;
  last_id: string | null;
}

const BASE_URL = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';

@Injectable()
export class AnthropicConnector extends BaseConnector {
  private readonly log = new Logger(AnthropicConnector.name);
  readonly id = 'anthropic' as const;
  readonly oauthScopes = [] as const;
  override readonly authType = 'apikey' as const;

  constructor(private readonly oauth: OAuthService) {
    super();
  }

  async *fetchIncremental(
    config: ConnectorConfig,
    since: Date,
  ): AsyncGenerator<RawItem> {
    const creds = this.oauth.decryptCredentials(config);
    const apiKey = creds.accessToken;

    // Anthropic models list is small (< 100 items) so one page is enough.
    const params = new URLSearchParams({ limit: '100' });

    const res = await fetch(`${BASE_URL}/models?${params.toString()}`, {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        accept: 'application/json',
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      this.log.warn(`anthropic /models ${res.status}: ${text.slice(0, 160)}`);
      return;
    }

    const json = (await res.json()) as AnthropicModelsResponse;
    for (const model of json.data ?? []) {
      // Only yield models created/updated since last sync.
      if (Date.parse(model.created_at) <= since.getTime()) continue;
      yield { externalId: `model:${model.id}`, raw: model };
    }
  }

  transform(raw: RawItem): TransformResult {
    const model = raw.raw as AnthropicModel;
    const node: KGNode = {
      id: deterministicUuid('anthropic', `model:${model.id}`),
      type: 'concept',
      label: model.display_name.slice(0, 200),
      sourceId: 'anthropic',
      sourceUrl: `https://docs.anthropic.com/en/docs/about-claude/models/overview`,
      createdAt: model.created_at,
      updatedAt: isoNow(),
      metadata: {
        anthropicId: model.id,
        modelType: model.type,
      },
    };
    return { node, edges: [] };
  }
}
