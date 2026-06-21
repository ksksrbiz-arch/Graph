import { KGNodeSchema, type ConnectorConfig } from '@pkg/shared';
import { ZoteroConnector } from './zotero.connector';
import { deterministicUuid } from './connector-utils';
import type { OAuthService } from '../oauth/oauth.service';
import type { RawItem } from './base.connector';

// ── test doubles ────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<ConnectorConfig> = {}): ConnectorConfig {
  return {
    id: 'zotero',
    userId: 'user-123',
    enabled: true,
    credentials: {
      ciphertext: 'x',
      iv: 'y',
      keyId: 'z',
    },
    syncIntervalMinutes: 30,
    ...overrides,
  };
}

function makeOAuth(blob: { accessToken: string; groupId?: string }): OAuthService {
  return {
    decryptCredentials: jest.fn().mockReturnValue(blob),
  } as unknown as OAuthService;
}

interface ZoteroItemFixture {
  key: string;
  version: number;
  library: { type: string; id: number };
  data: Record<string, unknown>;
}

function jsonResponse(
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const sampleItem: ZoteroItemFixture = {
  key: 'ABCD1234',
  version: 77,
  library: { type: 'user', id: 1 },
  data: {
    key: 'ABCD1234',
    version: 77,
    itemType: 'journalArticle',
    title: 'Attention Is All You Need',
    creators: [
      { creatorType: 'author', firstName: 'Ashish', lastName: 'Vaswani' },
      { creatorType: 'editor', name: 'Some Editor' },
    ],
    abstractNote: 'The dominant sequence transduction models...',
    date: 'June 2017',
    DOI: '10.1000/xyz',
    url: 'https://example.com/paper',
    publicationTitle: 'NeurIPS',
    tags: [{ tag: 'transformers' }, { tag: 'NLP' }],
    collections: ['COLL01'],
    dateAdded: '2024-01-01T00:00:00Z',
    dateModified: '2025-06-01T00:00:00Z',
  },
};

describe('ZoteroConnector', () => {
  let fetchSpy: jest.SpyInstance;

  afterEach(() => {
    fetchSpy?.mockRestore();
    jest.clearAllMocks();
  });

  it('exposes the stable connector identity and apikey auth', () => {
    const connector = new ZoteroConnector(makeOAuth({ accessToken: 'k' }));
    expect(connector.id).toBe('zotero');
    expect(connector.authType).toBe('apikey');
    expect(connector.oauthScopes).toEqual([]);
  });

  describe('fetchIncremental', () => {
    it('calls the personal-library items endpoint with the API key header', async () => {
      fetchSpy = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          jsonResponse([sampleItem], { 'Total-Results': '1' }),
        );

      const connector = new ZoteroConnector(makeOAuth({ accessToken: 'my-key' }));
      const items: RawItem[] = [];
      for await (const item of connector.fetchIncremental(
        makeConfig(),
        new Date('2020-01-01T00:00:00Z'),
      )) {
        items.push(item);
      }

      expect(items).toHaveLength(1);
      expect(items[0].externalId).toBe('ABCD1234');

      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('https://api.zotero.org/users/user-123/items');
      const headers = init.headers as Record<string, string>;
      expect(headers['Zotero-API-Key']).toBe('my-key');
      expect(headers['Zotero-API-Version']).toBe('3');
    });

    it('targets the group library when a groupId is configured', async () => {
      fetchSpy = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(jsonResponse([], { 'Total-Results': '0' }));

      const connector = new ZoteroConnector(
        makeOAuth({ accessToken: 'k', groupId: '99' }),
      );
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of connector.fetchIncremental(
        makeConfig(),
        new Date(0),
      )) {
        /* drain */
      }

      const [url] = fetchSpy.mock.calls[0] as [string];
      expect(url).toContain('https://api.zotero.org/groups/99/items');
    });

    it('stops once items predate the since cursor', async () => {
      const old = {
        ...sampleItem,
        key: 'OLD1',
        data: { ...sampleItem.data, key: 'OLD1', dateModified: '2019-01-01T00:00:00Z' },
      };
      const fresh = {
        ...sampleItem,
        key: 'NEW1',
        data: { ...sampleItem.data, key: 'NEW1', dateModified: '2025-01-01T00:00:00Z' },
      };
      fetchSpy = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          jsonResponse([fresh, old], { 'Total-Results': '2' }),
        );

      const connector = new ZoteroConnector(makeOAuth({ accessToken: 'k' }));
      const ids: string[] = [];
      for await (const item of connector.fetchIncremental(
        makeConfig(),
        new Date('2020-06-01T00:00:00Z'),
      )) {
        ids.push(item.externalId);
      }
      expect(ids).toEqual(['NEW1']);
    });

    it('stops cleanly on a non-2xx response', async () => {
      fetchSpy = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('nope', { status: 403 }));

      const connector = new ZoteroConnector(makeOAuth({ accessToken: 'bad' }));
      const items: RawItem[] = [];
      for await (const item of connector.fetchIncremental(
        makeConfig(),
        new Date(0),
      )) {
        items.push(item);
      }
      expect(items).toHaveLength(0);
    });

    it('does not throw when fetch rejects', async () => {
      fetchSpy = jest
        .spyOn(globalThis, 'fetch')
        .mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const connector = new ZoteroConnector(makeOAuth({ accessToken: 'k' }));
      const items: RawItem[] = [];
      for await (const item of connector.fetchIncremental(
        makeConfig(),
        new Date(0),
      )) {
        items.push(item);
      }
      expect(items).toHaveLength(0);
    });
  });

  describe('transform', () => {
    const connector = new ZoteroConnector(makeOAuth({ accessToken: 'k' }));

    it('maps an item to a schema-valid document node with reference metadata', () => {
      const { node } = connector.transform({
        externalId: sampleItem.key,
        raw: sampleItem,
      });

      expect(KGNodeSchema.safeParse(node).success).toBe(true);
      expect(node.type).toBe('document');
      expect(node.sourceId).toBe('zotero');
      expect(node.label).toBe('Attention Is All You Need');
      expect(node.id).toBe(deterministicUuid('zotero', sampleItem.key));
      expect(node.sourceUrl).toBe('https://example.com/paper');

      const meta = node.metadata as Record<string, unknown>;
      expect(meta.itemType).toBe('journalArticle');
      expect(meta.authors).toEqual(['Ashish Vaswani', 'Some Editor']);
      expect(meta.year).toBe(2017);
      expect(meta.zoteroKey).toBe('ABCD1234');
    });

    it('emits AUTHORED_BY edges carrying the synthesised person identity', () => {
      const { edges } = connector.transform({
        externalId: sampleItem.key,
        raw: sampleItem,
      });
      const authored = edges.filter((e) => e.relation === 'AUTHORED_BY');
      expect(authored).toHaveLength(2);
      const author = authored.find(
        (e) => (e.metadata as { personLabel?: string }).personLabel === 'Ashish Vaswani',
      );
      expect(author).toBeDefined();
      // primary authors weighted higher than editors
      expect(author?.weight).toBeGreaterThan(
        authored.find(
          (e) => (e.metadata as { creatorType?: string }).creatorType === 'editor',
        )?.weight ?? 1,
      );
    });

    it('emits TAGGED_WITH edges for each tag', () => {
      const { edges } = connector.transform({
        externalId: sampleItem.key,
        raw: sampleItem,
      });
      const tagged = edges.filter((e) => e.relation === 'TAGGED_WITH');
      expect(tagged.map((e) => (e.metadata as { tagLabel?: string }).tagLabel)).toEqual([
        'transformers',
        'NLP',
      ]);
    });

    it('emits PART_OF edges for collections', () => {
      const { edges } = connector.transform({
        externalId: sampleItem.key,
        raw: sampleItem,
      });
      const partOf = edges.filter((e) => e.relation === 'PART_OF');
      expect(partOf).toHaveLength(1);
      expect(partOf[0].target).toBe(deterministicUuid('zotero', 'collection:COLL01'));
    });

    it('falls back to a DOI source URL and (untitled) label when fields are missing', () => {
      const bare: ZoteroItemFixture = {
        key: 'BARE1',
        version: 1,
        library: { type: 'user', id: 1 },
        data: { key: 'BARE1', version: 1, itemType: 'book', DOI: '10.1/abc' },
      };
      const { node } = connector.transform({ externalId: 'BARE1', raw: bare });
      expect(node.label).toBe('(untitled)');
      expect(node.sourceUrl).toBe('https://doi.org/10.1/abc');
      const meta = node.metadata as Record<string, unknown>;
      expect(meta.authors).toEqual([]);
      expect(meta.year).toBeNull();
    });
  });
});
