import { parseMarkdown, parseText, stableUuid } from './text-parser';

const baseOpts = {
  userId: 'local',
  sourceId: 'bookmarks' as const,
  title: 'Test paste',
  now: () => '2026-04-27T12:00:00.000Z',
};

describe('parseText', () => {
  it('produces a document parent and one note per non-trivial paragraph', () => {
    const text = `First paragraph that has #important text.

Second paragraph mentioning https://example.com/page and another #important tag.`;
    const result = parseText(text, baseOpts);

    const parent = result.nodes.find((n) => n.id === result.parentId);
    expect(parent?.type).toBe('document');
    expect(result.nodes.filter((n) => n.type === 'note')).toHaveLength(2);
    // The same hashtag should fold into a single concept node.
    expect(result.nodes.filter((n) => n.type === 'concept')).toHaveLength(1);
    expect(result.nodes.find((n) => n.type === 'bookmark')?.sourceUrl).toBe(
      'https://example.com/page',
    );
    // PART_OF edges connect notes back to the document; TAGGED_WITH connects
    // notes to concepts; REFERENCES connects notes to bookmarks.
    const relations = result.edges.map((e) => e.relation);
    expect(relations).toContain('PART_OF');
    expect(relations).toContain('TAGGED_WITH');
    expect(relations).toContain('REFERENCES');
  });

  it('is idempotent — same input produces the same node ids', () => {
    const a = parseText('Same content here long enough.', baseOpts);
    const b = parseText('Same content here long enough.', baseOpts);
    expect(a.nodes.map((n) => n.id).sort()).toEqual(b.nodes.map((n) => n.id).sort());
  });
});

describe('parseMarkdown', () => {
  it('picks up the first H1 as the document label and emits LINKS_TO for wikilinks', () => {
    const md = `# My Notes

Some intro paragraph.

## Section

Reference to [[Other note]] and a tag #demo.`;
    const result = parseMarkdown(md, baseOpts);
    const parent = result.nodes.find((n) => n.id === result.parentId);
    expect(parent?.label).toBe('My Notes');
    expect(result.edges.some((e) => e.relation === 'LINKS_TO')).toBe(true);
    expect(result.nodes.some((n) => n.label === 'Other note')).toBe(true);
  });
});

describe('stableUuid', () => {
  it('matches the v4 UUID layout', () => {
    const id = stableUuid('local', 'note', 'hello');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
