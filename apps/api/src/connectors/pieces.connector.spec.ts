import { KGNodeSchema, type ConnectorConfig } from '@pkg/shared';
import { PiecesConnector } from './pieces.connector';
import { deterministicUuid } from './connector-utils';
import type { OAuthService } from '../oauth/oauth.service';
import type { RawItem } from './base.connector';

// ── test doubles ────────────────────────────────────────────────────────────

function makeConfig(): ConnectorConfig {
  return {
    id: 'pieces',
    userId: 'user-123',
    enabled: true,
    credentials: { ciphertext: 'x', iv: 'y', keyId: 'z' },
    syncIntervalMinutes: 30,
  };
}

function makeOAuth(accessToken: string): OAuthService {
  return {
    decryptCredentials: jest.fn().mockReturnValue({ accessToken }),
  } as unknown as OAuthService;
}

interface PiecesAssetFixture {
  id: string;
  name?: string;
  description?: { onboarding?: { text?: string } };
  created: { value?: string };
  updated: { value?: string };
  tags?: { iterable?: Array<{ id: string; text: string }> };
  websites?: { iterable?: Array<{ id: string; url: string; name?: string }> };
  formats?: {
    iterable?: Array<{
      classification?: { generic?: string; specific?: string };
      fragment?: { string?: { raw?: string } };
    }>;
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const codeAsset: PiecesAssetFixture = {
  id: 'asset-code-1',
  name: 'debounce helper',
  created: { value: '2025-01-01T00:00:00Z' },
  updated: { value: '2025-06-01T00:00:00Z' },
  tags: { iterable: [{ id: 't1', text: 'utils' }, { id: 't2', text: 'JS' }] },
  websites: {
    iterable: [{ id: 'w1', url: 'https://mdn.dev/debounce', name: 'MDN' }],
  },
  formats: {
    iterable: [
      {
        classification: { generic: 'CODE', specific: 'typescript' },
        fragment: { string: { raw: 'export function debounce() {}' } },
      },
    ],
  },
};

const noteAsset: PiecesAssetFixture = {
  id: 'asset-note-1',
  created: { value: '2025-02-01T00:00:00Z' },
  updated: { value: '2025-05-01T00:00:00Z' },
  formats: {
    iterable: [
      {
        classification: { generic: 'TEXT', specific: 'text' },
        fragment: { string: { raw: 'Remember to renew the SSL cert\nmore detail here' } },
      },
    ],
  },
};

describe('PiecesConnector', () => {
  let fetchSpy: jest.SpyInstance;

  afterEach(() => {
    fetchSpy?.mockRestore();
    jest.clearAllMocks();
  });

  it('exposes the stable connector identity and apikey auth', () => {
    const connector = new PiecesConnector(makeOAuth(''));
    expect(connector.id).toBe('pieces');
    expect(connector.authType).toBe('apikey');
    expect(connector.oauthScopes).toEqual([]);
  });

  describe('fetchIncremental', () => {
    it('queries the default local Pieces OS /assets endpoint', async () => {
      fetchSpy = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(jsonResponse({ iterable: [codeAsset] }));

      const connector = new PiecesConnector(makeOAuth(''));
      const items: RawItem[] = [];
      for await (const item of connector.fetchIncremental(
        makeConfig(),
        new Date('2020-01-01T00:00:00Z'),
      )) {
        items.push(item);
      }

      expect(items).toHaveLength(1);
      expect(items[0].externalId).toBe('asset-code-1');
      const [url] = fetchSpy.mock.calls[0] as [string];
      expect(url).toContain('http://localhost:1000/assets');
    });

    it('honours a custom base URL stored in the credential token', async () => {
      fetchSpy = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(jsonResponse({ iterable: [] }));

      const connector = new PiecesConnector(makeOAuth('http://localhost:2001'));
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of connector.fetchIncremental(makeConfig(), new Date(0))) {
        /* drain */
      }
      const [url] = fetchSpy.mock.calls[0] as [string];
      expect(url).toContain('http://localhost:2001/assets');
    });

    it('stops once assets predate the since cursor', async () => {
      const stale: PiecesAssetFixture = {
        ...codeAsset,
        id: 'stale',
        updated: { value: '2019-01-01T00:00:00Z' },
      };
      const fresh: PiecesAssetFixture = {
        ...codeAsset,
        id: 'fresh',
        updated: { value: '2025-01-01T00:00:00Z' },
      };
      fetchSpy = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(jsonResponse({ iterable: [fresh, stale] }));

      const connector = new PiecesConnector(makeOAuth(''));
      const ids: string[] = [];
      for await (const item of connector.fetchIncremental(
        makeConfig(),
        new Date('2020-06-01T00:00:00Z'),
      )) {
        ids.push(item.externalId);
      }
      expect(ids).toEqual(['fresh']);
    });

    it('does not throw when the local Pieces OS is unreachable', async () => {
      fetchSpy = jest
        .spyOn(globalThis, 'fetch')
        .mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const connector = new PiecesConnector(makeOAuth(''));
      const items: RawItem[] = [];
      for await (const item of connector.fetchIncremental(makeConfig(), new Date(0))) {
        items.push(item);
      }
      expect(items).toHaveLength(0);
    });

    it('stops cleanly on a non-2xx response', async () => {
      fetchSpy = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('err', { status: 500 }));

      const connector = new PiecesConnector(makeOAuth(''));
      const items: RawItem[] = [];
      for await (const item of connector.fetchIncremental(makeConfig(), new Date(0))) {
        items.push(item);
      }
      expect(items).toHaveLength(0);
    });
  });

  describe('transform', () => {
    const connector = new PiecesConnector(makeOAuth(''));

    it('maps a code asset to a schema-valid `code` node', () => {
      const { node } = connector.transform({
        externalId: codeAsset.id,
        raw: { asset: codeAsset, observedAt: '2025-06-01T00:00:00Z' },
      });

      expect(KGNodeSchema.safeParse(node).success).toBe(true);
      expect(node.type).toBe('code');
      expect(node.sourceId).toBe('pieces');
      expect(node.label).toBe('debounce helper');
      expect(node.id).toBe(deterministicUuid('pieces', codeAsset.id));
      const meta = node.metadata as Record<string, unknown>;
      expect(meta.language).toBe('typescript');
    });

    it('maps a plain text asset to a `note` node', () => {
      const { node } = connector.transform({
        externalId: noteAsset.id,
        raw: { asset: noteAsset, observedAt: '2025-05-01T00:00:00Z' },
      });
      expect(node.type).toBe('note');
      const meta = node.metadata as Record<string, unknown>;
      expect(meta.language).toBeNull();
      // label derived from first line of snippet content
      expect(node.label).toContain('Remember to renew the SSL cert');
    });

    it('emits TAGGED_WITH edges carrying the tag identity', () => {
      const { edges } = connector.transform({
        externalId: codeAsset.id,
        raw: { asset: codeAsset, observedAt: '2025-06-01T00:00:00Z' },
      });
      const tagged = edges.filter((e) => e.relation === 'TAGGED_WITH');
      expect(tagged).toHaveLength(2);
      expect(tagged.map((e) => (e.metadata as { tagLabel?: string }).tagLabel)).toEqual([
        'utils',
        'JS',
      ]);
    });

    it('emits LINKS_TO edges for associated websites', () => {
      const { edges } = connector.transform({
        externalId: codeAsset.id,
        raw: { asset: codeAsset, observedAt: '2025-06-01T00:00:00Z' },
      });
      const links = edges.filter((e) => e.relation === 'LINKS_TO');
      expect(links).toHaveLength(1);
      expect((links[0].metadata as { websiteUrl?: string }).websiteUrl).toBe(
        'https://mdn.dev/debounce',
      );
    });
  });
});
