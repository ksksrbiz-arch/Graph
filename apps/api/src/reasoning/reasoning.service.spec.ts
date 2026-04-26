import { NotFoundException } from '@nestjs/common';
import { ReasoningService } from './reasoning.service';
import type { ReasoningRepository } from './reasoning.repository';

function makeRepo(overrides: Partial<ReasoningRepository> = {}): ReasoningRepository {
  return {
    loadUserGraph: jest.fn().mockResolvedValue({ nodes: [], edges: [] }),
    loadNode: jest.fn().mockResolvedValue(null),
    loadNodeLabels: jest.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as ReasoningRepository;
}

describe('ReasoningService', () => {
  it('embeds text into a 384-dim vector', () => {
    const svc = new ReasoningService(makeRepo());
    const v = svc.embedText('graph reasoning');
    expect(v).toHaveLength(384);
  });

  it('classifies a connector-emailed label as email', () => {
    const svc = new ReasoningService(makeRepo());
    const r = svc.classify({ label: 'Re: review', connector: 'gmail' });
    expect(r.type).toBe('email');
  });

  it('similarNodes throws NotFound when the seed node does not exist', async () => {
    const svc = new ReasoningService(makeRepo());
    await expect(svc.similarNodes('u', 'missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('similarNodes ranks by cosine similarity over labels', async () => {
    const svc = new ReasoningService(
      makeRepo({
        loadNode: jest
          .fn()
          .mockResolvedValue({ id: 'seed', label: 'graph database neo4j', type: 'concept' }),
        loadNodeLabels: jest.fn().mockResolvedValue([
          { id: 'a', label: 'graph database storage', type: 'concept' },
          { id: 'b', label: 'lasagna recipe', type: 'note' },
          { id: 'c', label: 'graph traversal algorithm', type: 'concept' },
          { id: 'seed', label: 'graph database neo4j', type: 'concept' },
        ]),
      }),
    );
    const ranked = await svc.similarNodes('u', 'seed', 2);
    expect(ranked.length).toBe(2);
    expect(ranked[0]!.id).not.toBe('seed');
    // The lasagna entry must rank below the graph-database entries.
    const rankedIds = ranked.map((r) => r.id);
    expect(rankedIds).not.toContain('b');
  });

  it('predictLinks delegates to the reasoning algorithm with the chosen method', async () => {
    const svc = new ReasoningService(
      makeRepo({
        loadUserGraph: jest.fn().mockResolvedValue({
          nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
          edges: [
            { source: 'a', target: 'b' },
            { source: 'a', target: 'c' },
            { source: 'b', target: 'd' },
            { source: 'c', target: 'd' },
          ],
        }),
      }),
    );
    const preds = await svc.predictLinks('u', 'a', 'common-neighbours', 5);
    expect(preds.map((p) => p.target)).toContain('d');
  });

  it('reasoningPath finds the strongest connection between two nodes', async () => {
    const svc = new ReasoningService(
      makeRepo({
        loadUserGraph: jest.fn().mockResolvedValue({
          nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
          edges: [
            { source: 'a', target: 'b', weight: 0.9 },
            { source: 'b', target: 'c', weight: 0.9 },
          ],
        }),
      }),
    );
    const path = await svc.reasoningPath('u', 'a', 'c');
    expect(path).not.toBeNull();
    expect(path!.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c']);
  });

  it('summarise returns a neighbourhood summary', async () => {
    const svc = new ReasoningService(
      makeRepo({
        loadUserGraph: jest.fn().mockResolvedValue({
          nodes: [
            { id: 'a', type: 'person' },
            { id: 'b', type: 'email', label: 'Hi' },
            { id: 'c', type: 'email', label: 'Hello' },
            { id: 'd', type: 'document', label: 'Spec' },
          ],
          edges: [
            { source: 'a', target: 'b', weight: 0.5 },
            { source: 'a', target: 'c', weight: 0.7 },
            { source: 'a', target: 'd', weight: 0.3 },
          ],
        }),
      }),
    );
    const s = await svc.summarise('u', 'a');
    expect(s.degree).toBe(3);
    expect(s.neighbourTypes.email).toBe(2);
    expect(s.neighbourTypes.document).toBe(1);
    expect(s.topNeighbour?.id).toBe('c');
  });

  it('summarise throws NotFound when the node does not exist', async () => {
    const svc = new ReasoningService(
      makeRepo({
        loadUserGraph: jest.fn().mockResolvedValue({
          nodes: [{ id: 'other' }],
          edges: [],
        }),
      }),
    );
    await expect(svc.summarise('u', 'missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
