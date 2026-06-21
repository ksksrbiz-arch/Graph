// Unit test for the Gmail connector. No real network: global `fetch` is stubbed
// with a queue of canned Gmail API responses, and OAuthService.decryptCredentials
// is mocked to hand back a static access token.

import { GmailConnector } from './gmail.connector';
import type { RawItem } from './base.connector';
import type { ConnectorConfig } from '@pkg/shared';
import type { OAuthService } from '../oauth/oauth.service';

/** Build a Response-like object good enough for authedFetch. */
function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const status = init.status ?? 200;
  const headers = new Headers(init.headers ?? {});
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function makeConfig(extra: Partial<ConnectorConfig> = {}): ConnectorConfig {
  return {
    id: 'gmail',
    userId: 'user-1',
    enabled: true,
    credentials: { ciphertext: 'x', iv: 'y', keyId: 'k' },
    syncIntervalMinutes: 30,
    ...extra,
  };
}

function makeOAuth(): OAuthService {
  return {
    decryptCredentials: jest.fn().mockReturnValue({
      accessToken: 'tok-123',
      // No expiresAt → ensureFreshToken returns the token as-is, no refresh.
    }),
    refresh: jest.fn(),
  } as unknown as OAuthService;
}

const SAMPLE_MESSAGE = {
  id: 'msg-aaa',
  threadId: 'thread-zzz',
  historyId: '42',
  internalDate: '1718000000000', // 2024-06-10T...Z
  snippet: 'Quick question about the roadmap',
  labelIds: ['INBOX', 'IMPORTANT'],
  payload: {
    headers: [
      { name: 'Subject', value: 'Roadmap sync' },
      { name: 'From', value: 'Ada Lovelace <ada@example.com>' },
      { name: 'To', value: 'Grace Hopper <grace@example.com>, bob@example.com' },
      { name: 'Cc', value: 'carol@example.com' },
      { name: 'Date', value: 'Mon, 10 Jun 2024 00:00:00 +0000' },
    ],
  },
};

describe('GmailConnector', () => {
  let connector: GmailConnector;
  let oauth: OAuthService;
  let fetchMock: jest.Mock;
  const realFetch = global.fetch;

  beforeEach(() => {
    oauth = makeOAuth();
    connector = new GmailConnector(oauth);
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
    jest.clearAllMocks();
  });

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

  it('does a full list on first sync and maps a message into a node + edges', async () => {
    // First sync: no historyId on config → messages.list, then messages.get.
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ messages: [{ id: 'msg-aaa', threadId: 'thread-zzz' }] }),
      )
      .mockResolvedValueOnce(jsonResponse(SAMPLE_MESSAGE));

    const items = await drain(makeConfig(), new Date(0));

    expect(items).toHaveLength(1);
    // First call should be the list endpoint, second the get endpoint.
    const firstUrl = String(fetchMock.mock.calls[0][0]);
    const secondUrl = String(fetchMock.mock.calls[1][0]);
    expect(firstUrl).toContain('/users/me/messages?');
    expect(secondUrl).toContain('/users/me/messages/msg-aaa');
    expect(secondUrl).toContain('format=metadata');

    const { node, edges } = connector.transform(items[0]);

    expect(node.type).toBe('email');
    expect(node.label).toBe('Roadmap sync');
    expect(node.sourceId).toBe('gmail');
    expect(node.sourceUrl).toContain('msg-aaa');
    expect(node.createdAt).toBe(new Date(1718000000000).toISOString());
    expect(node.metadata.from).toBe('ada@example.com');
    expect(node.metadata.fromName).toBe('Ada Lovelace');
    expect(node.metadata.to).toEqual([
      'grace@example.com',
      'bob@example.com',
      'carol@example.com',
    ]);
    expect(node.metadata.snippet).toBe('Quick question about the roadmap');
    expect(node.metadata.threadId).toBe('thread-zzz');

    // One AUTHORED_BY (sender) + three MENTIONS (to/cc recipients).
    const relations = edges.map((e) => e.relation).sort();
    expect(relations).toEqual([
      'AUTHORED_BY',
      'MENTIONS',
      'MENTIONS',
      'MENTIONS',
    ]);
    // Every edge originates from the email node.
    expect(edges.every((e) => e.source === node.id)).toBe(true);
    expect(edges.every((e) => e.inferred === false)).toBe(true);
  });

  it('advances the historyId cursor to the newest watermark seen', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ messages: [{ id: 'msg-aaa', threadId: 'thread-zzz' }] }),
      )
      .mockResolvedValueOnce(jsonResponse(SAMPLE_MESSAGE));

    expect(connector.lastHistoryId).toBeUndefined();
    await drain(makeConfig(), new Date(0));
    expect(connector.lastHistoryId).toBe('42');
  });

  it('uses the history endpoint for incremental sync when a cursor exists', async () => {
    // Config carries a prior historyId → history.list, then messages.get.
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          history: [
            {
              id: '50',
              messagesAdded: [
                { message: { id: 'msg-aaa', threadId: 'thread-zzz' } },
              ],
            },
          ],
          historyId: '55',
        }),
      )
      .mockResolvedValueOnce(jsonResponse(SAMPLE_MESSAGE));

    const config = makeConfig({
      lastSyncAt: new Date(1700000000000).toISOString(),
    });
    (config as ConnectorConfig & { historyId?: string }).historyId = '10';

    const items = await drain(config, new Date(1700000000000));

    expect(items).toHaveLength(1);
    const firstUrl = String(fetchMock.mock.calls[0][0]);
    expect(firstUrl).toContain('/users/me/history?');
    expect(firstUrl).toContain('startHistoryId=10');
    // Cursor should advance to the top-level response historyId (55).
    expect(connector.lastHistoryId).toBe('55');
  });

  it('stops the sync gracefully on a non-2xx list response', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'boom' }, { status: 500 }),
    );

    const items = await drain(makeConfig(), new Date(0));
    expect(items).toHaveLength(0);
    // Only the list call was made; no message hydration attempted.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refreshes the token once on a 401 and retries', async () => {
    (oauth.refresh as jest.Mock).mockResolvedValue({ accessToken: 'tok-456' });
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, { status: 401 }))
      .mockResolvedValueOnce(
        jsonResponse({ messages: [{ id: 'msg-aaa', threadId: 'thread-zzz' }] }),
      )
      .mockResolvedValueOnce(jsonResponse(SAMPLE_MESSAGE));

    const items = await drain(makeConfig(), new Date(0));

    expect(oauth.refresh).toHaveBeenCalledTimes(1);
    expect(items).toHaveLength(1);
    // Retry should carry the refreshed token.
    const retryInit = fetchMock.mock.calls[1][1] as RequestInit;
    const authHeader = new Headers(retryInit.headers).get('authorization');
    expect(authHeader).toBe('Bearer tok-456');
  });
});
