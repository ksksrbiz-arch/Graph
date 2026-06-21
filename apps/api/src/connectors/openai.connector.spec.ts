// Unit test for the OpenAI connector. No network: the connector reads an
// exported ChatGPT `conversations.json` handed to it via the (mocked) decrypted
// credentials. OAuthService.decryptCredentials returns the in-memory fixture.

import { OpenAIConnector } from './openai.connector';
import type { RawItem } from './base.connector';
import type { ConnectorConfig } from '@pkg/shared';
import type { OAuthService } from '../oauth/oauth.service';

function makeConfig(extra: Partial<ConnectorConfig> = {}): ConnectorConfig {
  return {
    id: 'openai',
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

// A ChatGPT export uses the `mapping` tree of message nodes.
const SAMPLE_EXPORT = [
  {
    id: 'conv-1',
    title: 'Roadmap brainstorm',
    create_time: 1718000000, // 2024-06-10T...Z
    update_time: 1718000600,
    mapping: {
      root: { id: 'root', message: null, parent: null, children: ['m1'] },
      m1: {
        id: 'm1',
        message: {
          id: 'm1',
          author: { role: 'user' },
          create_time: 1718000100,
          content: { content_type: 'text', parts: ['What should we build next?'] },
        },
        parent: 'root',
        children: ['m2'],
      },
      m2: {
        id: 'm2',
        message: {
          id: 'm2',
          author: { role: 'assistant' },
          create_time: 1718000200,
          content: { content_type: 'text', parts: ['Consider a knowledge graph.'] },
        },
        parent: 'm1',
        children: [],
      },
      sys: {
        id: 'sys',
        message: {
          id: 'sys',
          author: { role: 'system' },
          create_time: 1718000050,
          content: { content_type: 'text', parts: [''] },
        },
        parent: 'root',
        children: [],
      },
    },
  },
];

describe('OpenAIConnector', () => {
  let connector: OpenAIConnector;

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
    connector = new OpenAIConnector(makeOAuth({ extra: { export: SAMPLE_EXPORT } }));
    const items = await drain(makeConfig(), new Date(0));

    // 1 conversation + 2 real (user/assistant) messages. The system message is
    // dropped (empty + non-user/assistant role).
    expect(items).toHaveLength(3);
    expect(items[0].externalId).toBe('conv-1');
    expect(items.slice(1).map((i) => i.externalId)).toEqual([
      'message:conv-1:m1',
      'message:conv-1:m2',
    ]);
  });

  it('maps a conversation to a document node', async () => {
    connector = new OpenAIConnector(makeOAuth({ extra: { export: SAMPLE_EXPORT } }));
    const [conv] = await drain(makeConfig(), new Date(0));
    const { node, edges } = connector.transform(conv);

    expect(node.type).toBe('document');
    expect(node.label).toBe('Roadmap brainstorm');
    expect(node.sourceId).toBe('openai');
    expect(node.sourceUrl).toBe('https://chatgpt.com/c/conv-1');
    expect(node.createdAt).toBe(new Date(1718000000 * 1000).toISOString());
    expect(node.updatedAt).toBe(new Date(1718000600 * 1000).toISOString());
    expect(node.metadata.messageCount).toBe(2);
    expect(edges).toHaveLength(0);
  });

  it('maps a message to a note node with a PART_OF edge to its conversation', async () => {
    connector = new OpenAIConnector(makeOAuth({ extra: { export: SAMPLE_EXPORT } }));
    const items = await drain(makeConfig(), new Date(0));
    const convNodeId = connector.transform(items[0]).node.id;

    const { node, edges } = connector.transform(items[1]);
    expect(node.type).toBe('note');
    expect(node.sourceId).toBe('openai');
    expect(node.label).toContain('user:');
    expect(node.metadata.role).toBe('user');
    expect(node.metadata.text).toBe('What should we build next?');
    expect(node.metadata.conversationId).toBe('conv-1');

    expect(edges).toHaveLength(1);
    expect(edges[0].relation).toBe('PART_OF');
    expect(edges[0].source).toBe(node.id);
    expect(edges[0].target).toBe(convNodeId);
    expect(edges[0].inferred).toBe(false);
  });

  it('produces deterministic, idempotent node ids across imports', async () => {
    connector = new OpenAIConnector(makeOAuth({ extra: { export: SAMPLE_EXPORT } }));
    const first = await drain(makeConfig(), new Date(0));
    const idsA = first.map((i) => connector.transform(i).node.id);

    connector = new OpenAIConnector(makeOAuth({ extra: { export: SAMPLE_EXPORT } }));
    const second = await drain(makeConfig(), new Date(0));
    const idsB = second.map((i) => connector.transform(i).node.id);

    expect(idsA).toEqual(idsB);
  });

  it('accepts the export as a raw JSON string in accessToken', async () => {
    connector = new OpenAIConnector(
      makeOAuth({ accessToken: JSON.stringify(SAMPLE_EXPORT) }),
    );
    const items = await drain(makeConfig(), new Date(0));
    expect(items[0].externalId).toBe('conv-1');
    expect(items).toHaveLength(3);
  });

  it('accepts an object-wrapped export ({ conversations: [...] })', async () => {
    connector = new OpenAIConnector(
      makeOAuth({ extra: { export: { conversations: SAMPLE_EXPORT } } }),
    );
    const items = await drain(makeConfig(), new Date(0));
    expect(items).toHaveLength(3);
  });

  it('filters out conversations not touched since the cursor', async () => {
    connector = new OpenAIConnector(makeOAuth({ extra: { export: SAMPLE_EXPORT } }));
    // since is after the conversation update_time → nothing yielded.
    const items = await drain(makeConfig(), new Date(1718000600 * 1000 + 1));
    expect(items).toHaveLength(0);
  });

  it('returns nothing when no export data is present', async () => {
    connector = new OpenAIConnector(makeOAuth({ extra: {} }));
    const items = await drain(makeConfig(), new Date(0));
    expect(items).toHaveLength(0);
  });

  it('supports flat message arrays in place of a mapping tree', async () => {
    const flat = [
      {
        id: 'conv-2',
        title: 'Flat conv',
        create_time: 1718000000,
        update_time: 1718000600,
        messages: [
          {
            id: 'fm1',
            author: { role: 'user' },
            create_time: 1718000100,
            content: { parts: ['hello'] },
          },
        ],
      },
    ];
    connector = new OpenAIConnector(makeOAuth({ extra: { export: flat } }));
    const items = await drain(makeConfig(), new Date(0));
    expect(items).toHaveLength(2);
    expect(connector.transform(items[1]).node.metadata.text).toBe('hello');
  });
});
