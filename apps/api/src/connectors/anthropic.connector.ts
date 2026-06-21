// Anthropic connector — ingests a user's exported Claude conversation history
// into the knowledge graph.
//
// Why an export, not the live API: the Anthropic API does not expose endpoints
// for listing a user's Claude.ai conversation history. Users instead request a
// data export (Settings → Privacy → Export data) which produces a
// `conversations.json` file. This connector reads that export — it makes NO
// live LLM/API calls.
//
// Where the export lives: the exported JSON is handed to the connector through
// the encrypted CredentialPayload, matching the file-based connector pattern.
// We accept it either as a parsed object/array on `extra.export` /
// `extra.conversations`, or as a raw JSON string in `accessToken`. This keeps
// the connector offline and deterministic.
//
// Mapping:
//   Conversation → KGNode type `document` (the conversation as a whole).
//   Message      → KGNode type `note`, linked to its conversation with a
//                  PART_OF edge. Messages carry sender + text in metadata.
//
// Idempotency (Rule 12): node ids are derived from the conversation/message
// uuid via `deterministicUuid`, so re-importing the same export is a MERGE.
//
// Docs: https://privacy.anthropic.com/en/articles/9450526-how-can-i-export-my-claude-ai-data

import { Injectable, Logger } from '@nestjs/common';
import type { ConnectorConfig, KGEdge, KGNode } from '@pkg/shared';
import { BaseConnector, type RawItem, type TransformResult } from './base.connector';
import {
  deterministicUuid,
  isoNow,
  newEdgeId,
} from './connector-utils';
import { OAuthService } from '../oauth/oauth.service';

// ── Claude export shapes ───────────────────────────────────────────────────

interface ClaudeContentBlock {
  type?: string;
  text?: string;
}

interface ClaudeChatMessage {
  uuid?: string;
  /** 'human' or 'assistant'. */
  sender?: string;
  /** Legacy/flat exports place the message text here. */
  text?: string;
  /** Newer exports place text inside a content-block array. */
  content?: ClaudeContentBlock[];
  created_at?: string; // ISO-8601
}

interface ClaudeConversation {
  uuid?: string;
  name?: string;
  created_at?: string; // ISO-8601
  updated_at?: string; // ISO-8601
  chat_messages?: ClaudeChatMessage[];
}

// ── Constants ──────────────────────────────────────────────────────────────

const MAX_LABEL_LENGTH = 200;
const MAX_TEXT_LENGTH = 2000;
/** PART_OF edge weight for message→conversation: structural containment. */
const MESSAGE_PART_OF_WEIGHT = 0.8;

/** Wrapper payloads yielded by fetchIncremental and consumed by transform. */
interface ConversationItem {
  kind: 'conversation';
  conversation: ClaudeConversation;
}
interface MessageItem {
  kind: 'message';
  conversationUuid: string;
  message: ClaudeChatMessage;
}
type AnthropicRaw = ConversationItem | MessageItem;

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
    const conversations = parseExport(creds, this.log);

    for (const conversation of conversations) {
      const uuid = conversation.uuid;
      if (!uuid) {
        this.log.warn('anthropic export: skipping conversation without a uuid');
        continue;
      }

      // Incremental filter: a conversation's updated_at (falling back to
      // created_at) is its watermark. Skip anything not touched since `since`.
      const touchedMs = parseIso(
        conversation.updated_at ?? conversation.created_at,
      );
      if (touchedMs !== undefined && touchedMs <= since.getTime()) continue;

      yield {
        externalId: uuid,
        raw: { kind: 'conversation', conversation } satisfies AnthropicRaw,
      };

      for (const message of conversation.chat_messages ?? []) {
        if (!message.uuid) continue;
        if (!messageText(message)) continue;
        yield {
          externalId: `message:${uuid}:${message.uuid}`,
          raw: {
            kind: 'message',
            conversationUuid: uuid,
            message,
          } satisfies AnthropicRaw,
        };
      }
    }
  }

  transform(raw: RawItem): TransformResult {
    const item = raw.raw as AnthropicRaw;
    if (item.kind === 'conversation') {
      return this.transformConversation(item.conversation);
    }
    return this.transformMessage(item);
  }

  // ── transform helpers ──────────────────────────────────────────────────

  private transformConversation(c: ClaudeConversation): TransformResult {
    const uuid = c.uuid ?? 'unknown';
    const createdAt = c.created_at ?? isoNow();
    const updatedAt = c.updated_at ?? createdAt;
    const messageCount = (c.chat_messages ?? []).filter(
      (m) => !!messageText(m),
    ).length;

    const node: KGNode = {
      id: deterministicUuid('anthropic', uuid),
      type: 'document',
      label: (c.name?.trim() || 'Untitled conversation').slice(0, MAX_LABEL_LENGTH),
      sourceId: 'anthropic',
      sourceUrl: `https://claude.ai/chat/${uuid}`,
      createdAt,
      updatedAt,
      metadata: {
        anthropicConversationId: uuid,
        messageCount,
      },
    };
    return { node, edges: [] };
  }

  private transformMessage(item: MessageItem): TransformResult {
    const { message, conversationUuid: convId } = item;
    const messageId = message.uuid ?? 'unknown';
    const externalId = `message:${convId}:${messageId}`;
    const text = messageText(message);
    const sender = message.sender ?? 'unknown';
    const createdAt = message.created_at ?? isoNow();

    const node: KGNode = {
      id: deterministicUuid('anthropic', externalId),
      type: 'note',
      label: labelFromText(sender, text),
      sourceId: 'anthropic',
      createdAt,
      updatedAt: createdAt,
      metadata: {
        anthropicMessageId: messageId,
        conversationId: convId,
        sender,
        text: text.slice(0, MAX_TEXT_LENGTH),
      },
    };

    // Message PART_OF its parent conversation. The conversation node id is
    // derived from the same deterministic scheme, so the edge resolves even
    // though the conversation node is yielded as a separate item.
    const conversationNodeId = deterministicUuid('anthropic', convId);
    const edges: KGEdge[] = [
      edgeBetween(node.id, conversationNodeId, 'PART_OF', MESSAGE_PART_OF_WEIGHT),
    ];
    return { node, edges };
  }
}

// ── module-level helpers ────────────────────────────────────────────────────

/** Read and normalize the exported conversations array from the credentials. */
function parseExport(
  creds: { accessToken?: string; extra?: Record<string, unknown> },
  log: Logger,
): ClaudeConversation[] {
  // Preferred: a parsed export object/array on `extra`.
  const fromExtra =
    creds.extra?.export ?? creds.extra?.conversations ?? undefined;
  if (fromExtra !== undefined) return coerceConversations(fromExtra);

  // Fallback: a raw JSON string in `accessToken`.
  const raw = creds.accessToken?.trim();
  if (raw) {
    try {
      return coerceConversations(JSON.parse(raw));
    } catch {
      log.warn('anthropic export: accessToken is not valid JSON; nothing to ingest');
      return [];
    }
  }

  log.warn('anthropic export: no export data found in credentials');
  return [];
}

/** A Claude export is either a top-level array of conversations or an object
 *  with a `conversations` array. Normalize both into a flat array. */
function coerceConversations(value: unknown): ClaudeConversation[] {
  if (Array.isArray(value)) return value as ClaudeConversation[];
  if (value && typeof value === 'object') {
    const inner = (value as { conversations?: unknown }).conversations;
    if (Array.isArray(inner)) return inner as ClaudeConversation[];
  }
  return [];
}

/** Resolve a message's text from either the flat `text` field or the content
 *  block array, joining text blocks. */
function messageText(message: ClaudeChatMessage): string {
  if (typeof message.text === 'string' && message.text.trim()) {
    return message.text.trim();
  }
  const blocks = message.content ?? [];
  return blocks
    .map((b) => (typeof b.text === 'string' ? b.text : ''))
    .join('\n')
    .trim();
}

function labelFromText(sender: string, text: string): string {
  const firstLine = text.split('\n')[0]?.trim() ?? '';
  const snippet = firstLine.length > 0 ? firstLine : text;
  return `${sender}: ${snippet}`.trim().slice(0, MAX_LABEL_LENGTH);
}

function parseIso(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
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
