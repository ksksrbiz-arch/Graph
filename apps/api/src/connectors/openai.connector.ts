// OpenAI connector — ingests objects the user has created in their OpenAI
// account via the platform API: uploaded Files and Assistants.
//
// Authentication: uses a plain API key (sk-…). The key is stored as
// `accessToken` inside the encrypted CredentialPayload, matching Zotero's
// pattern. No OAuth cycle is required.
//
// Files    → KGNode type `document`.  Covers every file purpose (fine-tune,
//            assistants, batch, vision) and maps the OpenAI file status to
//            metadata so the user can spot failed uploads in the graph.
//
// Assistants → KGNode type `concept`.  Each assistant you've built is a
//             conceptual entity that connects to the documents and tools it
//             uses, making it a natural first-class node.
//
// Idempotency (Rule 12): node ids are derived from the OpenAI object id via
// `deterministicUuid` so re-syncing the same file/assistant is a MERGE.
//
// Rate limits (Rule 13): the OpenAI API returns standard `x-ratelimit-*`
// headers; we surface them and bail out early when remaining < 5.
//
// Docs:
//   https://platform.openai.com/docs/api-reference/files/list
//   https://platform.openai.com/docs/api-reference/assistants/listAssistants

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

// ── OpenAI API shapes ─────────────────────────────────────────────────────

interface OpenAIFile {
  id: string;
  object: 'file';
  bytes: number;
  created_at: number; // unix timestamp
  filename: string;
  purpose: string;
  status?: string;
}

interface OpenAIAssistant {
  id: string;
  object: 'assistant';
  created_at: number; // unix timestamp
  name: string | null;
  description: string | null;
  model: string;
  instructions: string | null;
  tools: Array<{ type: string }>;
}

interface OpenAIListResponse<T> {
  object: 'list';
  data: T[];
  has_more: boolean;
  last_id: string | null;
  first_id: string | null;
}

const PAGE_SIZE = 100;
const MAX_PAGES = 3; // up to 300 files + 300 assistants per sync
const BASE_URL = 'https://api.openai.com/v1';
/** Weight assigned to assistant→model RELATED_TO edges — moderate confidence
 *  since the relationship is structural (the assistant is backed by this model)
 *  rather than semantic. */
const ASSISTANT_MODEL_EDGE_WEIGHT = 0.6;

@Injectable()
export class OpenAIConnector extends BaseConnector {
  private readonly log = new Logger(OpenAIConnector.name);
  readonly id = 'openai' as const;
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

    yield* this.fetchFiles(apiKey, since);
    yield* this.fetchAssistants(apiKey, since);
  }

  transform(raw: RawItem): TransformResult {
    const wrapper = raw.raw as { kind: 'file' | 'assistant'; data: unknown };
    if (wrapper.kind === 'file') return this.transformFile(wrapper.data as OpenAIFile);
    return this.transformAssistant(wrapper.data as OpenAIAssistant);
  }

  // ── private: fetch helpers ─────────────────────────────────────────────

  private async *fetchFiles(
    apiKey: string,
    since: Date,
  ): AsyncGenerator<RawItem> {
    let after: string | undefined;

    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        order: 'desc',
      });
      if (after) params.set('after', after);

      const { res, rate } = await authedFetch(
        `${BASE_URL}/files?${params.toString()}`,
        apiKey,
      );
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        this.log.warn(`openai /files ${res.status}: ${text.slice(0, 160)}`);
        return;
      }

      const json = (await res.json()) as OpenAIListResponse<OpenAIFile>;
      const items = json.data ?? [];

      let crossedSince = false;
      for (const f of items) {
        if (f.created_at * 1000 <= since.getTime()) {
          crossedSince = true;
          break;
        }
        yield { externalId: `file:${f.id}`, raw: { kind: 'file', data: f } };
      }

      if (crossedSince || !json.has_more || !json.last_id) return;
      if (rate.remaining !== undefined && rate.remaining < 5) {
        this.log.warn(`openai rate-limit low (${rate.remaining}); stopping files`);
        return;
      }
      after = json.last_id;
    }
  }

  private async *fetchAssistants(
    apiKey: string,
    since: Date,
  ): AsyncGenerator<RawItem> {
    let after: string | undefined;

    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        order: 'desc',
      });
      if (after) params.set('after', after);

      const { res, rate } = await authedFetch(
        `${BASE_URL}/assistants?${params.toString()}`,
        apiKey,
        { headers: { 'openai-beta': 'assistants=v2' } },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        this.log.warn(`openai /assistants ${res.status}: ${text.slice(0, 160)}`);
        return;
      }

      const json = (await res.json()) as OpenAIListResponse<OpenAIAssistant>;
      const items = json.data ?? [];

      let crossedSince = false;
      for (const a of items) {
        if (a.created_at * 1000 <= since.getTime()) {
          crossedSince = true;
          break;
        }
        yield {
          externalId: `assistant:${a.id}`,
          raw: { kind: 'assistant', data: a },
        };
      }

      if (crossedSince || !json.has_more || !json.last_id) return;
      if (rate.remaining !== undefined && rate.remaining < 5) {
        this.log.warn(
          `openai rate-limit low (${rate.remaining}); stopping assistants`,
        );
        return;
      }
      after = json.last_id;
    }
  }

  // ── private: transform helpers ─────────────────────────────────────────

  private transformFile(f: OpenAIFile): TransformResult {
    const createdAt = new Date(f.created_at * 1000).toISOString();
    const node: KGNode = {
      id: deterministicUuid('openai', `file:${f.id}`),
      type: 'document',
      label: f.filename.slice(0, 200),
      sourceId: 'openai',
      sourceUrl: `https://platform.openai.com/storage/files/${f.id}`,
      createdAt,
      updatedAt: createdAt,
      metadata: {
        openaiId: f.id,
        purpose: f.purpose,
        bytes: f.bytes,
        status: f.status ?? null,
      },
    };
    return { node, edges: [] };
  }

  private transformAssistant(a: OpenAIAssistant): TransformResult {
    const createdAt = new Date(a.created_at * 1000).toISOString();
    const label = (a.name ?? a.id).slice(0, 200);
    const node: KGNode = {
      id: deterministicUuid('openai', `assistant:${a.id}`),
      type: 'concept',
      label,
      sourceId: 'openai',
      sourceUrl: `https://platform.openai.com/assistants/${a.id}`,
      createdAt,
      updatedAt: createdAt,
      metadata: {
        openaiId: a.id,
        model: a.model,
        description: a.description ?? null,
        instructions: a.instructions?.slice(0, 500) ?? null,
        tools: a.tools.map((t) => t.type),
      },
    };

    const edges: KGEdge[] = [];
    // Link assistant → model concept node so the graph shows which model backs
    // which assistant (deterministic model node keeps this idempotent).
    const modelId = deterministicUuid('openai', `model:${a.model}`);
    edges.push(edgeBetween(node.id, modelId, 'RELATED_TO', ASSISTANT_MODEL_EDGE_WEIGHT));

    return { node, edges };
  }
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
