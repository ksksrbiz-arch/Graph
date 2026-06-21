// Unit tests for the Bookmarks connector.  No network and no DB: each test
// feeds an in-memory Netscape HTML or OPML export through fetchIncremental +
// transform and asserts on the produced KGNodes/KGEdges.

import type { ConnectorConfig } from '@pkg/shared';
import { BookmarksConnector } from './bookmarks.connector';
import type { RawItem } from './base.connector';
import type { OAuthService } from '../oauth/oauth.service';

// ── fixtures ──────────────────────────────────────────────────────────────

const NETSCAPE_HTML = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><A HREF="https://root.example/" ADD_DATE="1700000000">Root Mark &amp; Co</A>
    <DT><H3 ADD_DATE="1700000001">Toolbar</H3>
    <DL><p>
        <DT><A HREF="https://nest.example/dev" ADD_DATE="1700000100" TAGS="dev,reading">Dev Link</A>
        <DT><H3>Inner</H3>
        <DL><p>
            <DT><A HREF="https://deep.example/" ADD_DATE="1700000200">Deep One</A>
        </DL><p>
    </DL><p>
</DL><p>
`;

const OPML_XML = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>My Bookmarks</title></head>
  <body>
    <outline text="Folder A">
      <outline text="Site One" htmlUrl="https://one.example/" category="news,daily"/>
      <outline text="Site Two" url="https://two.example/"/>
    </outline>
    <outline text="Top Site" htmlUrl="https://top.example/"/>
  </body>
</opml>
`;

// ── helpers ───────────────────────────────────────────────────────────────

function makeConnector(
  documentText: string,
  format?: 'html' | 'opml' | 'auto',
): BookmarksConnector {
  const oauth = {
    decryptCredentials: () => ({
      accessToken: documentText,
      ...(format ? { extra: { format } } : {}),
    }),
  } as unknown as OAuthService;
  return new BookmarksConnector(oauth);
}

// Minimal ConnectorConfig — the connector only touches it via decryptCredentials,
// which is stubbed above, so the fields are placeholders.
const CONFIG = {
  id: 'bookmarks',
  userId: 'user-1',
  enabled: true,
  credentials: { ciphertext: '', iv: '', keyId: 'k' },
  syncIntervalMinutes: 30,
} as ConnectorConfig;

const EPOCH = new Date(0);

async function collect(gen: AsyncGenerator<RawItem>): Promise<RawItem[]> {
  const out: RawItem[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

// ── tests ─────────────────────────────────────────────────────────────────

describe('BookmarksConnector', () => {
  it('exposes apikey auth and the bookmarks id', () => {
    const c = makeConnector(NETSCAPE_HTML);
    expect(c.id).toBe('bookmarks');
    expect(c.authType).toBe('apikey');
    expect(c.oauthScopes).toEqual([]);
  });

  describe('Netscape HTML import', () => {
    it('parses every anchor into a RawItem', async () => {
      const c = makeConnector(NETSCAPE_HTML);
      const items = await collect(c.fetchIncremental(CONFIG, EPOCH));
      expect(items).toHaveLength(3);
      expect(items.map((i) => i.externalId)).toEqual([
        'mark:https://root.example/',
        'mark:https://nest.example/dev',
        'mark:https://deep.example/',
      ]);
    });

    it('maps a bookmark to a bookmark KGNode with decoded title and sourceUrl', () => {
      const c = makeConnector(NETSCAPE_HTML);
      const raw: RawItem = {
        externalId: 'mark:https://root.example/',
        raw: {
          bookmark: {
            href: 'https://root.example/',
            title: 'Root Mark & Co',
            folders: [],
            tags: [],
            addDate: 1700000000,
          },
        },
      };
      const { node, edges } = c.transform(raw);
      expect(node.type).toBe('bookmark');
      expect(node.label).toBe('Root Mark & Co');
      expect(node.sourceUrl).toBe('https://root.example/');
      expect(node.sourceId).toBe('bookmarks');
      expect(node.metadata.addDate).toBe(1700000000);
      // Root-level bookmark — no folder, no tag edges.
      expect(edges).toHaveLength(0);
    });

    it('decodes the &amp; entity in the title via the parser', async () => {
      const c = makeConnector(NETSCAPE_HTML);
      const items = await collect(c.fetchIncremental(CONFIG, EPOCH));
      const root = items.find(
        (i) => i.externalId === 'mark:https://root.example/',
      );
      const bm = (root?.raw as { bookmark: { title: string } }).bookmark;
      expect(bm.title).toBe('Root Mark & Co');
    });

    it('tracks nested folder paths', async () => {
      const c = makeConnector(NETSCAPE_HTML);
      const items = await collect(c.fetchIncremental(CONFIG, EPOCH));
      const deep = items.find(
        (i) => i.externalId === 'mark:https://deep.example/',
      );
      const bm = (deep?.raw as { bookmark: { folders: string[] } }).bookmark;
      expect(bm.folders).toEqual(['Toolbar', 'Inner']);
    });

    it('emits a PART_OF edge to the deepest folder', () => {
      const c = makeConnector(NETSCAPE_HTML);
      const { edges } = c.transform({
        externalId: 'x',
        raw: {
          bookmark: {
            href: 'https://deep.example/',
            title: 'Deep One',
            folders: ['Toolbar', 'Inner'],
            tags: [],
          },
        },
      });
      const partOf = edges.find((e) => e.relation === 'PART_OF');
      expect(partOf).toBeDefined();
      expect(partOf?.metadata.folderLabel).toBe('Inner');
      expect(partOf?.metadata.folderPath).toEqual(['Toolbar', 'Inner']);
    });

    it('parses TAGS and emits TAGGED_WITH concept edges', async () => {
      const c = makeConnector(NETSCAPE_HTML);
      const items = await collect(c.fetchIncremental(CONFIG, EPOCH));
      const dev = items.find(
        (i) => i.externalId === 'mark:https://nest.example/dev',
      );
      const bm = (dev?.raw as { bookmark: { tags: string[] } }).bookmark;
      expect(bm.tags).toEqual(['dev', 'reading']);

      const { edges } = c.transform(dev as RawItem);
      const tagEdges = edges.filter((e) => e.relation === 'TAGGED_WITH');
      expect(tagEdges).toHaveLength(2);
      expect(tagEdges.map((e) => e.metadata.tagLabel).sort()).toEqual([
        'dev',
        'reading',
      ]);
      // Tag identity is concept-typed for the merge step.
      expect(tagEdges[0]?.metadata.conceptType).toBe('concept');
    });

    it('filters out bookmarks added on or before `since`', async () => {
      const c = makeConnector(NETSCAPE_HTML);
      // since = epoch second 1700000100 → keeps only the strictly-newer one.
      const since = new Date(1700000100 * 1000);
      const items = await collect(c.fetchIncremental(CONFIG, since));
      expect(items.map((i) => i.externalId)).toEqual([
        'mark:https://deep.example/',
      ]);
    });
  });

  describe('OPML import', () => {
    it('treats linked outlines as bookmarks and bare outlines as folders', async () => {
      const c = makeConnector(OPML_XML);
      const items = await collect(c.fetchIncremental(CONFIG, EPOCH));
      expect(items.map((i) => i.externalId)).toEqual([
        'mark:https://one.example/',
        'mark:https://two.example/',
        'mark:https://top.example/',
      ]);
    });

    it('nests folder children and leaves top-level marks unfoldered', async () => {
      const c = makeConnector(OPML_XML);
      const items = await collect(c.fetchIncremental(CONFIG, EPOCH));
      const one = (
        items[0]?.raw as { bookmark: { folders: string[]; title: string } }
      ).bookmark;
      expect(one.title).toBe('Site One');
      expect(one.folders).toEqual(['Folder A']);

      const top = (items[2]?.raw as { bookmark: { folders: string[] } })
        .bookmark;
      expect(top.folders).toEqual([]);
    });

    it('parses category into tags', async () => {
      const c = makeConnector(OPML_XML);
      const items = await collect(c.fetchIncremental(CONFIG, EPOCH));
      const one = (items[0]?.raw as { bookmark: { tags: string[] } }).bookmark;
      expect(one.tags).toEqual(['news', 'daily']);
    });
  });

  describe('idempotency', () => {
    it('produces a stable node id across two parses of the same export', async () => {
      const a = makeConnector(NETSCAPE_HTML);
      const b = makeConnector(NETSCAPE_HTML);
      const itemsA = await collect(a.fetchIncremental(CONFIG, EPOCH));
      const itemsB = await collect(b.fetchIncremental(CONFIG, EPOCH));
      const idA = a.transform(itemsA[0] as RawItem).node.id;
      const idB = b.transform(itemsB[0] as RawItem).node.id;
      expect(idA).toBe(idB);
    });

    it('collapses the same tag across bookmarks to one concept id', () => {
      const c = makeConnector(NETSCAPE_HTML);
      const mk = (href: string) =>
        c.transform({
          externalId: href,
          raw: {
            bookmark: { href, title: href, folders: [], tags: ['Dev'] },
          },
        });
      const e1 = mk('https://a.example/').edges[0];
      const e2 = mk('https://b.example/').edges[0];
      expect(e1?.target).toBe(e2?.target);
    });
  });

  describe('edge cases', () => {
    it('does not turn a paired-leaf bookmark title into a folder for its children', async () => {
      const opml = `<?xml version="1.0"?>
<opml version="2.0"><body>
  <outline text="My Post" htmlUrl="https://post.example/">
    <outline text="Reply" htmlUrl="https://reply.example/"/>
  </outline>
</body></opml>`;
      const c = makeConnector(opml);
      const items = await collect(c.fetchIncremental(CONFIG, EPOCH));
      const reply = items.find(
        (i) => i.externalId === 'mark:https://reply.example/',
      );
      const bm = (reply?.raw as { bookmark: { folders: string[] } }).bookmark;
      // "My Post" is a bookmark, not a folder — it must not appear in the path.
      expect(bm.folders).toEqual([]);
    });

    it('survives a malformed surrogate numeric entity without aborting the import', async () => {
      const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
  <DT><A HREF="https://surrogate.example/">Bad &#xD800; Title</A>
</DL><p>`;
      const c = makeConnector(html);
      const items = await collect(c.fetchIncremental(CONFIG, EPOCH));
      expect(items).toHaveLength(1);
      const bm = (items[0]?.raw as { bookmark: { title: string } }).bookmark;
      // The invalid entity is left intact rather than throwing.
      expect(bm.title).toContain('&#xD800;');
    });

    it('yields nothing for an empty document', async () => {
      const c = makeConnector('   ');
      const items = await collect(c.fetchIncremental(CONFIG, EPOCH));
      expect(items).toEqual([]);
    });

    it('honours an explicit opml format hint over sniffing', async () => {
      const c = makeConnector(OPML_XML, 'opml');
      const items = await collect(c.fetchIncremental(CONFIG, EPOCH));
      expect(items).toHaveLength(3);
    });
  });
});
