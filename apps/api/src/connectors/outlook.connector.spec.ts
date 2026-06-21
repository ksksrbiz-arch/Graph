// Unit tests for OutlookConnector — fully mocked HTTP (global fetch) and
// dependencies; NO network. Covers message → KGNode mapping, sender/recipient
// edges, tombstone skipping, and delta-token cursor advance.

import { KGEdgeSchema, KGNodeSchema } from '@pkg/shared';
import type {
  ConnectorConfig,
  EncryptedCredentials,
  KGNode,
} from '@pkg/shared';
import { OutlookConnector } from './outlook.connector';
import type { RawItem } from './base.connector';
import type { OAuthService } from '../oauth/oauth.service';
import type { ConnectorConfigStore } from './connector-config.store';
import type { CredentialCipher } from '../shared/crypto/credential-cipher';

interface StoredCreds {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  extra?: Record<string, unknown>;
}

function makeConfig(creds: StoredCreds): ConnectorConfig {
  // The cipher is mocked to round-trip JSON, so we stash the plaintext here.
  const ciphertext = JSON.stringify(creds);
  return {
    id: 'outlook_mail',
    userId: 'user-1',
    enabled: true,
    credentials: { ciphertext, iv: 'iv', keyId: 'kek-v1' },
    syncIntervalMinutes: 30,
  };
}

/** OAuthService.decryptCredentials just JSON-parses our mock ciphertext. */
function makeOAuth(refreshToken = 'fresh-token'): {
  oauth: jest.Mocked<Pick<OAuthService, 'decryptCredentials' | 'refresh'>>;
} {
  const oauth = {
    decryptCredentials: jest.fn((config: ConnectorConfig) =>
      JSON.parse(config.credentials.ciphertext),
    ),
    refresh: jest.fn(async () => ({ accessToken: refreshToken })),
  } as unknown as jest.Mocked<
    Pick<OAuthService, 'decryptCredentials' | 'refresh'>
  >;
  return { oauth };
}

/** ConnectorConfigStore stub backed by a single mutable config. */
function makeStore(initial: ConnectorConfig): {
  store: jest.Mocked<Pick<ConnectorConfigStore, 'find' | 'upsert'>>;
  current: () => ConnectorConfig;
} {
  let held = initial;
  const store = {
    find: jest.fn(() => held),
    upsert: jest.fn((c: ConnectorConfig) => {
      held = c;
      return c;
    }),
  } as unknown as jest.Mocked<Pick<ConnectorConfigStore, 'find' | 'upsert'>>;
  return { store, current: () => held };
}

/** Cipher stub that round-trips plaintext through the ciphertext field. */
function makeCipher(): jest.Mocked<Pick<CredentialCipher, 'encrypt' | 'decrypt'>> {
  return {
    encrypt: jest.fn(
      (plaintext: string): EncryptedCredentials => ({
        ciphertext: plaintext,
        iv: 'iv',
        keyId: 'kek-v1',
      }),
    ),
    decrypt: jest.fn((c: EncryptedCredentials) => c.ciphertext),
  } as unknown as jest.Mocked<Pick<CredentialCipher, 'encrypt' | 'decrypt'>>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const sampleMessage = {
  id: 'AAMkAGI2-msg-1',
  subject: 'Quarterly planning sync',
  webLink: 'https://outlook.office365.com/owa/?ItemID=AAMkAGI2-msg-1',
  bodyPreview: 'Lets align on the roadmap before Friday.',
  receivedDateTime: '2026-06-20T15:04:05Z',
  lastModifiedDateTime: '2026-06-20T15:05:00Z',
  from: { emailAddress: { name: 'Dana Lee', address: 'dana@example.com' } },
  toRecipients: [
    { emailAddress: { name: 'Me', address: 'me@example.com' } },
    { emailAddress: { name: 'Sam', address: 'sam@example.com' } },
  ],
  ccRecipients: [
    // Duplicate of a To recipient — must be deduped to a single edge.
    { emailAddress: { name: 'Sam', address: 'SAM@example.com' } },
  ],
};

describe('OutlookConnector', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  function build(config: ConnectorConfig) {
    const { oauth } = makeOAuth();
    const { store, current } = makeStore(config);
    const cipher = makeCipher();
    const connector = new OutlookConnector(
      oauth as unknown as OAuthService,
      store as unknown as ConnectorConfigStore,
      cipher as unknown as CredentialCipher,
    );
    return { connector, oauth, store, cipher, current };
  }

  it('maps a Graph message to a valid email KGNode with sender/recipient edges', async () => {
    const config = makeConfig({ accessToken: 'tok' });
    const { connector } = build(config);

    global.fetch = jest.fn(async () =>
      jsonResponse({
        value: [sampleMessage],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages/delta?$deltatoken=ROUND1',
      }),
    ) as unknown as typeof fetch;

    const items: RawItem[] = [];
    for await (const item of connector.fetchIncremental(config, new Date(0))) {
      items.push(item);
    }
    expect(items).toHaveLength(1);
    expect(items[0]!.externalId).toBe('AAMkAGI2-msg-1');

    const { node, edges } = connector.transform(items[0]!);

    // Node shape passes the shared zod contract.
    expect(KGNodeSchema.safeParse(node).success).toBe(true);
    expect(node.type).toBe('email');
    expect(node.label).toBe('Quarterly planning sync');
    expect(node.sourceUrl).toBe(sampleMessage.webLink);
    expect(node.sourceId).toBe('outlook_mail');
    const meta = node.metadata as Record<string, unknown>;
    expect(meta.from).toBe('dana@example.com');
    expect(meta.received).toBe('2026-06-20T15:04:05Z');
    expect(meta.preview).toContain('roadmap');
    expect(meta.to).toEqual(['me@example.com', 'sam@example.com']);

    // Edges: one AUTHORED_BY (sender) + two MENTIONS (me, sam — SAM deduped).
    for (const e of edges) expect(KGEdgeSchema.safeParse(e).success).toBe(true);
    const relations = edges.map((e) => e.relation).sort();
    expect(relations).toEqual(['AUTHORED_BY', 'MENTIONS', 'MENTIONS']);
    expect(edges.every((e) => e.source === node.id)).toBe(true);
  });

  it('produces a deterministic, stable node id across syncs (Rule 12)', () => {
    const config = makeConfig({ accessToken: 'tok' });
    const { connector } = build(config);
    const a = connector.transform({ externalId: 'x', raw: sampleMessage });
    const b = connector.transform({ externalId: 'x', raw: sampleMessage });
    expect(a.node.id).toBe(b.node.id);
  });

  it('skips @removed tombstones', async () => {
    const config = makeConfig({ accessToken: 'tok' });
    const { connector } = build(config);
    global.fetch = jest.fn(async () =>
      jsonResponse({
        value: [
          { id: 'gone', '@removed': { reason: 'deleted' } },
          sampleMessage,
        ],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?$deltatoken=R',
      }),
    ) as unknown as typeof fetch;

    const ids: string[] = [];
    for await (const item of connector.fetchIncremental(config, new Date(0))) {
      ids.push(item.externalId);
    }
    expect(ids).toEqual(['AAMkAGI2-msg-1']);
  });

  it('follows @odata.nextLink across pages then persists the deltaLink cursor', async () => {
    const config = makeConfig({ accessToken: 'tok' });
    const { connector, store, current } = build(config);

    const NEXT = 'https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages/delta?$skiptoken=PAGE2';
    const DELTA = 'https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages/delta?$deltatoken=DONE';

    const urls: string[] = [];
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const u = String(input);
      urls.push(u);
      if (urls.length === 1) {
        // First page: a message + nextLink (more to come).
        return jsonResponse({
          value: [{ ...sampleMessage, id: 'msg-page1' }],
          '@odata.nextLink': NEXT,
        });
      }
      // Second page: a message + deltaLink (round complete).
      return jsonResponse({
        value: [{ ...sampleMessage, id: 'msg-page2' }],
        '@odata.deltaLink': DELTA,
      });
    }) as unknown as typeof fetch;

    const ids: string[] = [];
    for await (const item of connector.fetchIncremental(config, new Date(0))) {
      ids.push(item.externalId);
    }

    // Both pages drained, second request used the nextLink URL verbatim.
    expect(ids).toEqual(['msg-page1', 'msg-page2']);
    expect(urls[1]).toBe(NEXT);

    // Cursor advanced: the deltaLink is persisted onto the config credentials.
    expect(store.upsert).toHaveBeenCalledTimes(1);
    const persisted = JSON.parse(current().credentials.ciphertext) as StoredCreds;
    expect(persisted.extra?.deltaLink).toBe(DELTA);
  });

  it('resumes from a stored deltaLink and advances the cursor when it changes', async () => {
    const STORED = 'https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages/delta?$deltatoken=STORED';
    const NEXT_DELTA = 'https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages/delta?$deltatoken=NEXT';
    const config = makeConfig({
      accessToken: 'tok',
      extra: { deltaLink: STORED },
    });
    const { connector, store, current } = build(config);

    const urls: string[] = [];
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return jsonResponse({
        value: [sampleMessage],
        '@odata.deltaLink': NEXT_DELTA,
      });
    }) as unknown as typeof fetch;

    for await (const _ of connector.fetchIncremental(config, new Date(0))) {
      void _;
    }
    // First (and only) request must be the stored deltaLink, not a fresh
    // /messages/delta?$filter=... initial query.
    expect(urls).toHaveLength(1);
    expect(urls[0]).toBe(STORED);
    // Cursor advanced to the new deltaLink returned this round.
    expect(store.upsert).toHaveBeenCalledTimes(1);
    const persisted = JSON.parse(current().credentials.ciphertext) as StoredCreds;
    expect(persisted.extra?.deltaLink).toBe(NEXT_DELTA);
  });

  it('does not re-persist when the deltaLink is unchanged', async () => {
    const STORED = 'https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages/delta?$deltatoken=STORED';
    const config = makeConfig({ accessToken: 'tok', extra: { deltaLink: STORED } });
    const { connector, store } = build(config);
    global.fetch = jest.fn(async () =>
      jsonResponse({ value: [], '@odata.deltaLink': STORED }),
    ) as unknown as typeof fetch;
    for await (const _ of connector.fetchIncremental(config, new Date(0))) void _;
    expect(store.upsert).not.toHaveBeenCalled();
  });

  it('persists the last nextLink as the cursor when the page cap is hit mid-round', async () => {
    const config = makeConfig({ accessToken: 'tok' });
    const { connector, store, current } = build(config);

    // Every page returns a fresh nextLink (never a deltaLink), forcing the
    // MAX_PAGES cap. The cursor must still advance to the last nextLink so the
    // next sync resumes mid-round instead of re-walking from `since`.
    let n = 0;
    let lastNext = '';
    global.fetch = jest.fn(async () => {
      n += 1;
      lastNext = `https://graph.microsoft.com/v1.0/delta?$skiptoken=PAGE${n}`;
      return jsonResponse({
        value: [{ ...sampleMessage, id: `msg-${n}` }],
        '@odata.nextLink': lastNext,
      });
    }) as unknown as typeof fetch;

    const ids: string[] = [];
    for await (const item of connector.fetchIncremental(config, new Date(0))) {
      ids.push(item.externalId);
    }
    // Drained exactly MAX_PAGES pages then stopped.
    expect(ids.length).toBeGreaterThan(1);
    expect(store.upsert).toHaveBeenCalledTimes(1);
    const persisted = JSON.parse(current().credentials.ciphertext) as StoredCreds;
    expect(persisted.extra?.deltaLink).toBe(lastNext);
  });

  it('refreshes on a 401 and retries the request with the new token', async () => {
    // expiresAt in the future so ensureFreshToken does not pre-refresh.
    const config = makeConfig({
      accessToken: 'stale',
      refreshToken: 'rt',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const { connector, oauth } = build(config); // refresh resolves 'fresh-token'

    const seenTokens: (string | null)[] = [];
    let call = 0;
    global.fetch = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      call += 1;
      const auth = new Headers(init?.headers).get('authorization');
      seenTokens.push(auth);
      if (call === 1) return new Response('unauthorized', { status: 401 });
      return jsonResponse({
        value: [sampleMessage],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?$deltatoken=Z',
      });
    }) as unknown as typeof fetch;

    const ids: string[] = [];
    for await (const item of connector.fetchIncremental(config, new Date(0))) {
      ids.push(item.externalId);
    }
    expect(oauth.refresh).toHaveBeenCalledTimes(1);
    expect(ids).toEqual(['AAMkAGI2-msg-1']);
    // The retry must carry the refreshed token, not the stale one.
    expect(seenTokens[0]).toBe('Bearer stale');
    expect(seenTokens[1]).toBe('Bearer fresh-token');
  });

  it('raises when the request is still 401 after a refresh', async () => {
    const config = makeConfig({
      accessToken: 'stale',
      refreshToken: 'rt',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const { connector } = build(config);

    global.fetch = jest.fn(async () =>
      new Response('nope', { status: 401 }),
    ) as unknown as typeof fetch;

    await expect(async () => {
      for await (const _ of connector.fetchIncremental(config, new Date(0))) {
        void _;
      }
    }).rejects.toThrow(/unauthorized after token refresh/);
  });

  it('omits sourceUrl and falls back to a placeholder label when fields are missing', () => {
    const config = makeConfig({ accessToken: 'tok' });
    const { connector } = build(config);
    const node: KGNode = connector.transform({
      externalId: 'm',
      raw: { id: 'm', receivedDateTime: '2026-01-01T00:00:00Z' },
    }).node;
    expect(node.label).toBe('(no subject)');
    expect(node.sourceUrl).toBeUndefined();
    expect(KGNodeSchema.safeParse(node).success).toBe(true);
  });
});
