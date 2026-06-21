// Unit test for the Anthropic connector. No network: the connector reads an
// exported Claude `conversations.json` handed to it via the (mocked) decrypted
// credentials. OAuthService.decryptCredentials returns the in-memory fixture.

import { AnthropicConnector } from './anthropic.connector';
import type { RawItem } from './base.connector';
import type { ConnectorConfig } from '@pkg/shared';
import type { OAuthService } from '../oauth/oauth.service';

function makeConfig(extra: Partial<ConnectorConfig> = {}): ConnectorConfig {
  return {
    id: 'anthropic',
    userId: 'user-1',
    enabled: true,
    credentials: { ciphertext: 'x', iv: 'y', keyId: 'k' },
    syncIntervalMinutes: 30,
    ...extra,
  };
}

/** Build an OAuthService stub whose decryptCredentials returns `creds`. */
function makeOAuth(creds: unknown): OAuthService {
  return {
    decryptCredentials: jest.fn().mockReturnValue(creds),
    refresh: jest.fn(),
  } as unknown as OAuthService;
}

// A Claude export: array of conversations each with a chat_messages array.
const SAMPLE_EXPORT = [
  {
    uuid: 'conv-1',
    name: 'Graph design chat',
    created_at: '2024-06-10T00:00:00Z',
    updated_at: '2024-06-10T01:00:00Z',
    chat_messages: [
      {
        uuid: 'm1',
        sender: 'human',
        text: 'How should I model conversations?',
        created_at: '2024-06-10T00:10:00Z',
      },
      {
        uuid: 'm2',
        sender: 'assistant',
        // Newer exports use content blocks instead of a flat `text`.
        content: [{ type: 'text', text: 'Use a document node per conversation.' }],
        created_at: '2024-06-10T00:11:00Z',
      },
      {
        // Empty message — should be skipped.
        uuid: 'm3',
        sender: 'human',
        text: '   ',
        created_at: '2024-06-10T00:12:00Z',
      },
    ],
  },
];

describe('AnthropicConnector', () => {
  let connector: AnthropicConnector;

  async function drain(
    config: ConnectorConfig,
    since: Date,
  ): Promise<RawItem[]> {
    const out: RawItem[] = [];
    for await (const item of connector.fetchIncremental(config, since)) {
      out.push(item);
    }
    return out;
  }

  afterEach(() => jest.clearAllMocks());

  it('reads the export from extra.export and yields a conversation + its messages', async () => {
    connector = new AnthropicConnector(makeOAuth({ extra: { export: SAMPLE_EXPORT } }));
    const items = await drain(makeConfig(), new Date(0));

    // 1 conversation + 2 non-empty messages (the blank m3 is dropped).
    expect(items).toHaveLength(3);
    expect(items[0].externalId).toBe('conv-1');
    expect(items.slice(1).map((i) => i.externalId)).toEqual([
      'message:conv-1:m1',
      'message:conv-1:m2',
    ]);
  });

  it('maps a conversation to a document node', async () => {
    connector = new AnthropicConnector(makeOAuth({ extra: { export: SAMPLE_EXPORT } }));
    const [conv] = await drain(makeConfig(), new Date(0));
    const { node, edges } = connector.transform(conv);

    expect(node.type).toBe('document');
    expect(node.label).toBe('Graph design chat');
    expect(node.sourceId).toBe('anthropic');
    expect(node.sourceUrl).toBe('https://claude.ai/chat/conv-1');
    expect(node.createdAt).toBe('2024-06-10T00:00:00Z');
    expect(node.updatedAt).toBe('2024-06-10T01:00:00Z');
    expect(node.metadata.messageCount).toBe(2);
    expect(edges).toHaveLength(0);
  });

  it('maps a message to a note node with a PART_OF edge to its conversation', async () => {
    connector = new AnthropicConnector(makeOAuth({ extra: { export: SAMPLE_EXPORT } }));
    const items = await drain(makeConfig(), new Date(0));
    const convNodeId = connector.transform(items[0]).node.id;

    const { node, edges } = connector.transform(items[1]);
    expect(node.type).toBe('note');
    expect(node.sourceId).toBe('anthropic');
    expect(node.label).toContain('human:');
    expect(node.metadata.sender).toBe('human');
    expect(node.metadata.text).toBe('How should I model conversations?');
    expect(node.metadata.conversationId).toBe('conv-1');

    expect(edges).toHaveLength(1);
    expect(edges[0].relation).toBe('PART_OF');
    expect(edges[0].source).toBe(node.id);
    expect(edges[0].target).toBe(convNodeId);
    expect(edges[0].inferred).toBe(false);
  });

  it('resolves message text from content blocks when there is no flat text', async () => {
    connector = new AnthropicConnector(makeOAuth({ extra: { export: SAMPLE_EXPORT } }));
    const items = await drain(makeConfig(), new Date(0));
    const { node } = connector.transform(items[2]);
    expect(node.metadata.text).toBe('Use a document node per conversation.');
  });

  it('produces deterministic, idempotent node ids across imports', async () => {
    connector = new AnthropicConnector(makeOAuth({ extra: { export: SAMPLE_EXPORT } }));
    const first = await drain(makeConfig(), new Date(0));
    const idsA = first.map((i) => connector.transform(i).node.id);

    connector = new AnthropicConnector(makeOAuth({ extra: { export: SAMPLE_EXPORT } }));
    const second = await drain(makeConfig(), new Date(0));
    const idsB = second.map((i) => connector.transform(i).node.id);

    expect(idsA).toEqual(idsB);
  });

  it('accepts the export as a raw JSON string in accessToken', async () => {
    connector = new AnthropicConnector(
      makeOAuth({ accessToken: JSON.stringify(SAMPLE_EXPORT) }),
    );
    const items = await drain(makeConfig(), new Date(0));
    expect(items[0].externalId).toBe('conv-1');
    expect(items).toHaveLength(3);
  });

  it('accepts an object-wrapped export ({ conversations: [...] })', async () => {
    connector = new AnthropicConnector(
      makeOAuth({ extra: { export: { conversations: SAMPLE_EXPORT } } }),
    );
    const items = await drain(makeConfig(), new Date(0));
    expect(items).toHaveLength(3);
  });

  it('filters out conversations not touched since the cursor', async () => {
    connector = new AnthropicConnector(makeOAuth({ extra: { export: SAMPLE_EXPORT } }));
    const items = await drain(
      makeConfig(),
      new Date('2024-06-10T02:00:00Z'),
    );
    expect(items).toHaveLength(0);
  });

  it('returns nothing when no export data is present', async () => {
    connector = new AnthropicConnector(makeOAuth({ extra: {} }));
    const items = await drain(makeConfig(), new Date(0));
    expect(items).toHaveLength(0);
  });
});
