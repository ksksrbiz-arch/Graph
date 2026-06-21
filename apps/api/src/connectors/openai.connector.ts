// OpenAI connector — ingests a user's exported ChatGPT conversation history
// into the knowledge graph.
//
// Why an export, not the live API: OpenAI does not expose an API to list a
// user's ChatGPT conversation history. Users instead request a data export
// (Settings → Data controls → Export data) which produces a `conversations.json`
// file. This connector reads that export — it makes NO live LLM/API calls.
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
//                  PART_OF edge. Messages carry author role + text in metadata.
//
// Idempotency (Rule 12): node ids are derived from the conversation/message id
// via `deterministicUuid`, so re-importing the same export is a MERGE.
//
// Docs: https://help.openai.com/en/articles/7260999-how-do-i-export-my-chatgpt-history-and-data

import { Injectable, Logger } from '@nestjs/common';
import type { ConnectorConfig, KGEdge, KGNode } from '@pkg/shared';
import { BaseConnector, type RawItem, type TransformResult } from './base.connector';
import {
  deterministicUuid,
  isoNow,
  newEdgeId,
} from './connector-utils';
import { OAuthService } from '../oauth/oauth.service';

// ── ChatGPT export shapes ──────────────────────────────────────────────────

interface ChatGPTAuthor {
  role?: string;
}

interface ChatGPTContent {
  content_type?: string;
  parts?: unknown[];
}

interface ChatGPTMessage {
  id?: string;
  author?: ChatGPTAuthor;
  create_time?: number | null; // unix seconds
  content?: ChatGPTContent;
}

interface ChatGPTMappingNode {
  id?: string;
  message?: ChatGPTMessage | null;
  parent?: string | null;
  children?: string[];
}

interface ChatGPTConversation {
  id?: string;
  conversation_id?: string;
  title?: string;
  create_time?: number | null; // unix seconds
  update_time?: number | null; // unix seconds
  mapping?: Record<string, ChatGPTMappingNode>;
  /** Some exports inline a flat `messages` array instead of `mapping`. */
  messages?: ChatGPTMessage[];
}

// ── Constants ──────────────────────────────────────────────────────────────

const MAX_LABEL_LENGTH = 200;
const MAX_TEXT_LENGTH = 2000;
/** PART_OF edge weight for message→conversation: structural containment. */
const MESSAGE_PART_OF_WEIGHT = 0.8;

/** Wrapper payloads yielded by fetchIncremental and consumed by transform. */
interface ConversationItem {
  kind: 'conversation';
  conversation: ChatGPTConversation;
}
interface MessageItem {
  kind: 'message';
  conversationExternalId: string;
  message: ChatGPTMessage;
}
type OpenAIRaw = ConversationItem | MessageItem;

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
    const conversations = parseExport(creds, this.log);

    for (const conversation of conversations) {
      const externalId = conversationExternalId(conversation);
      if (!externalId) {
        this.log.warn('openai export: skipping conversation without an id');
        continue;
      }

      // Incremental filter: a conversation's update_time (falling back to
      // create_time) is its watermark. Skip anything not touched since `since`.
      const touchedMs = unixToMs(
        conversation.update_time ?? conversation.create_time,
      );
      if (touchedMs !== undefined && touchedMs <= since.getTime()) continue;

      yield {
        externalId,
        raw: { kind: 'conversation', conversation } satisfies OpenAIRaw,
      };

      for (const message of collectMessages(conversation)) {
        const role = message.author?.role;
        // Skip system/tool scaffolding and empty messages — only user/assistant
        // turns with real text become note nodes.
        if (role !== 'user' && role !== 'assistant') continue;
        if (!messageText(message)) continue;
        if (!message.id) continue;
        yield {
          externalId: `message:${externalId}:${message.id}`,
          raw: {
            kind: 'message',
            conversationExternalId: externalId,
            message,
          } satisfies OpenAIRaw,
        };
      }
    }
  }

  transform(raw: RawItem): TransformResult {
    const item = raw.raw as OpenAIRaw;
    if (item.kind === 'conversation') {
      return this.transformConversation(item.conversation);
    }
    return this.transformMessage(item);
  }

  // ── transform helpers ──────────────────────────────────────────────────

  private transformConversation(c: ChatGPTConversation): TransformResult {
    const externalId = conversationExternalId(c) ?? 'unknown';
    const createdAt = isoFromUnix(c.create_time) ?? isoNow();
    const updatedAt = isoFromUnix(c.update_time) ?? createdAt;
    const messageCount = collectMessages(c).filter((m) => {
      const role = m.author?.role;
      return (role === 'user' || role === 'assistant') && !!messageText(m);
    }).length;

    const node: KGNode = {
      id: deterministicUuid('openai', externalId),
      type: 'document',
      label: (c.title?.trim() || 'Untitled conversation').slice(0, MAX_LABEL_LENGTH),
      sourceId: 'openai',
      ...sourceUrlFor(c),
      createdAt,
      updatedAt,
      metadata: {
        openaiConversationId: externalId,
        messageCount,
      },
    };
    return { node, edges: [] };
  }

  private transformMessage(item: MessageItem): TransformResult {
    const { message, conversationExternalId: convId } = item;
    const messageId = message.id ?? 'unknown';
    const externalId = `message:${convId}:${messageId}`;
    const text = messageText(message);
    const role = message.author?.role ?? 'unknown';
    const createdAt = isoFromUnix(message.create_time) ?? isoNow();

    const node: KGNode = {
      id: deterministicUuid('openai', externalId),
      type: 'note',
      label: labelFromText(role, text),
      sourceId: 'openai',
      createdAt,
      updatedAt: createdAt,
      metadata: {
        openaiMessageId: messageId,
        conversationId: convId,
        role,
        text: text.slice(0, MAX_TEXT_LENGTH),
      },
    };

    // Message PART_OF its parent conversation. The conversation node id is
    // derived from the same deterministic scheme, so the edge resolves even
    // though the conversation node is yielded as a separate item.
    const conversationNodeId = deterministicUuid('openai', convId);
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
): ChatGPTConversation[] {
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
      log.warn('openai export: accessToken is not valid JSON; nothing to ingest');
      return [];
    }
  }

  log.warn('openai export: no export data found in credentials');
  return [];
}

/** A ChatGPT export is either a top-level array of conversations or an object
 *  with a `conversations` array. Normalize both into a flat array. */
function coerceConversations(value: unknown): ChatGPTConversation[] {
  if (Array.isArray(value)) return value as ChatGPTConversation[];
  if (value && typeof value === 'object') {
    const inner = (value as { conversations?: unknown }).conversations;
    if (Array.isArray(inner)) return inner as ChatGPTConversation[];
  }
  return [];
}

function conversationExternalId(c: ChatGPTConversation): string | undefined {
  return c.conversation_id ?? c.id ?? undefined;
}

/** Build the optional `sourceUrl` deep-link for a conversation, omitted when no
 *  id is present so we never emit an `undefined` property. */
function sourceUrlFor(c: ChatGPTConversation): { sourceUrl?: string } {
  const id = c.conversation_id ?? c.id;
  return id ? { sourceUrl: `https://chatgpt.com/c/${id}` } : {};
}

/** Collect messages from a conversation, supporting both the `mapping` tree and
 *  a flat `messages` array. */
function collectMessages(c: ChatGPTConversation): ChatGPTMessage[] {
  if (c.mapping && typeof c.mapping === 'object') {
    const out: ChatGPTMessage[] = [];
    for (const key of Object.keys(c.mapping)) {
      const msg = c.mapping[key]?.message;
      if (msg) out.push(msg);
    }
    return out;
  }
  if (Array.isArray(c.messages)) return c.messages;
  return [];
}

/** Join the text parts of a message into a single trimmed string. */
function messageText(message: ChatGPTMessage): string {
  const parts = message.content?.parts ?? [];
  return parts
    .filter((p): p is string => typeof p === 'string')
    .join('\n')
    .trim();
}

function labelFromText(role: string, text: string): string {
  const firstLine = text.split('\n')[0]?.trim() ?? '';
  const snippet = firstLine.length > 0 ? firstLine : text;
  return `${role}: ${snippet}`.trim().slice(0, MAX_LABEL_LENGTH);
}

function unixToMs(seconds: number | null | undefined): number | undefined {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return undefined;
  return seconds * 1000;
}

function isoFromUnix(seconds: number | null | undefined): string | undefined {
  const ms = unixToMs(seconds);
  return ms === undefined ? undefined : new Date(ms).toISOString();
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
