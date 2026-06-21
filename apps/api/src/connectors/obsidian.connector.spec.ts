// Unit tests for the Obsidian vault connector. No network, no filesystem: the
// vault is passed in as in-memory `{path, content}` fixtures through a stubbed
// OAuthService.decryptCredentials.

import { KGEdgeSchema, KGNodeSchema } from '@pkg/shared';
import type { ConnectorConfig } from '@pkg/shared';
import { ObsidianConnector, type ObsidianFile } from './obsidian.connector';
import type { RawItem } from './base.connector';
import { OAuthService } from '../oauth/oauth.service';

// Build a connector whose decryptCredentials yields the given vault file list.
function makeConnector(files: ObsidianFile[]): ObsidianConnector {
  const oauth = {
    decryptCredentials: () => ({ accessToken: JSON.stringify({ files }) }),
  } as unknown as OAuthService;
  return new ObsidianConnector(oauth);
}

// Minimal config object — the stub ignores it, so the shape is irrelevant.
const CONFIG = {} as unknown as ConnectorConfig;
const EPOCH = new Date(0);

async function collect(gen: AsyncGenerator<RawItem>): Promise<RawItem[]> {
  const items: RawItem[] = [];
  for await (const item of gen) items.push(item);
  return items;
}

describe('ObsidianConnector', () => {
  it('exposes apikey auth and the obsidian id', () => {
    const c = makeConnector([]);
    expect(c.id).toBe('obsidian');
    expect(c.authType).toBe('apikey');
    expect(c.oauthScopes).toEqual([]);
  });

  describe('fetchIncremental', () => {
    it('yields one item per markdown file', async () => {
      const c = makeConnector([
        { path: 'A.md', content: '# A' },
        { path: 'Folder/B.markdown', content: '# B' },
      ]);
      const items = await collect(c.fetchIncremental(CONFIG, EPOCH));
      expect(items.map((i) => i.externalId)).toEqual([
        'note:A.md',
        'note:Folder/B.markdown',
      ]);
    });

    it('skips non-markdown and malformed entries', async () => {
      const c = makeConnector([
        { path: 'note.md', content: 'ok' },
        { path: 'image.png', content: 'binary' },
        { path: '', content: 'no path' },
        { path: 'broken.md', content: undefined as unknown as string },
      ]);
      const items = await collect(c.fetchIncremental(CONFIG, EPOCH));
      expect(items.map((i) => i.externalId)).toEqual(['note:note.md']);
    });

    it('filters files modified at or before `since`', async () => {
      const c = makeConnector([
        { path: 'old.md', content: 'x', modifiedAt: '2020-01-01T00:00:00.000Z' },
        { path: 'new.md', content: 'y', modifiedAt: '2026-01-01T00:00:00.000Z' },
      ]);
      const since = new Date('2024-01-01T00:00:00.000Z');
      const items = await collect(c.fetchIncremental(CONFIG, since));
      expect(items.map((i) => i.externalId)).toEqual(['note:new.md']);
    });

    it('returns nothing for an empty or invalid payload', async () => {
      const oauth = {
        decryptCredentials: () => ({ accessToken: 'not json' }),
      } as unknown as OAuthService;
      const c = new ObsidianConnector(oauth);
      const items = await collect(c.fetchIncremental(CONFIG, EPOCH));
      expect(items).toEqual([]);
    });
  });

  describe('transform', () => {
    function transformFile(file: ObsidianFile) {
      const c = makeConnector([file]);
      return c.transform({ externalId: `note:${file.path}`, raw: { file, observedAt: 'now' } });
    }

    it('maps a note file to a note KGNode with title from basename', () => {
      const { node } = transformFile({ path: 'Projects/Graph.md', content: 'body' });
      expect(node.type).toBe('note');
      expect(node.label).toBe('Graph');
      expect(node.sourceId).toBe('obsidian');
      expect(node.metadata).toMatchObject({ path: 'Projects/Graph.md', title: 'Graph' });
      expect(KGNodeSchema.safeParse(node).success).toBe(true);
    });

    it('produces TAGGED_WITH edges for #tags', () => {
      const { edges } = transformFile({ path: 'N.md', content: 'see #idea and #Idea and #todo-list' });
      const tagEdges = edges.filter((e) => e.relation === 'TAGGED_WITH');
      // #idea and #Idea collapse (case-folded); #todo-list is distinct.
      expect(tagEdges).toHaveLength(2);
      expect(tagEdges.map((e) => (e.metadata as { tag: string }).tag).sort()).toEqual([
        'idea',
        'todo-list',
      ]);
      for (const e of tagEdges) expect(KGEdgeSchema.safeParse(e).success).toBe(true);
    });

    it('produces LINKS_TO edges for wikilinks resolved by title', () => {
      const { edges } = transformFile({
        path: 'Source.md',
        content: 'links to [[Target]] and [[Other#Section|Alias]]',
      });
      const linkEdges = edges.filter((e) => e.relation === 'LINKS_TO');
      expect(linkEdges).toHaveLength(2);
      const aliased = linkEdges.find(
        (e) => (e.metadata as { targetTitle: string }).targetTitle === 'Other',
      );
      expect(aliased?.metadata).toMatchObject({ section: 'Section', alias: 'Alias' });
      for (const e of linkEdges) expect(KGEdgeSchema.safeParse(e).success).toBe(true);
    });

    it('resolves a wikilink to the same id the target note will receive', () => {
      const source = transformFile({ path: 'Source.md', content: 'go to [[Target]]' });
      const target = transformFile({ path: 'Folder/Target.md', content: 'I am the target' });
      const linkEdge = source.edges.find((e) => e.relation === 'LINKS_TO');
      expect(linkEdge?.target).toBe(target.node.id);
    });

    it('matches wikilink targets case-insensitively', () => {
      const source = transformFile({ path: 'Source.md', content: '[[target]]' });
      const target = transformFile({ path: 'Target.md', content: 'x' });
      const linkEdge = source.edges.find((e) => e.relation === 'LINKS_TO');
      expect(linkEdge?.target).toBe(target.node.id);
    });

    it('drops self-links', () => {
      const { edges } = transformFile({ path: 'Self.md', content: 'I reference [[Self]]' });
      expect(edges.filter((e) => e.relation === 'LINKS_TO')).toHaveLength(0);
    });

    it('is idempotent — same file yields the same node id', () => {
      const a = transformFile({ path: 'Same.md', content: 'one' });
      const b = transformFile({ path: 'Same.md', content: 'two' });
      expect(a.node.id).toBe(b.node.id);
    });
  });
});
