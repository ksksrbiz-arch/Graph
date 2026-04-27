import { Test } from '@nestjs/testing';
import type { KGNode } from '@pkg/shared';
import { GraphRepository } from './graph.repository';
import { SmartConnectionsService } from './smart-connections.service';

function makeNode(id: string, label: string): KGNode {
  return {
    id,
    label,
    type: 'note',
    sourceId: 'obsidian',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: {},
  };
}

describe('SmartConnectionsService', () => {
  let service: SmartConnectionsService;
  let repo: jest.Mocked<Pick<GraphRepository, 'snapshotForUser'>>;

  const nodes: KGNode[] = [
    makeNode('anchor', 'machine learning neural network'),
    makeNode('similar-1', 'deep learning neural network'),
    makeNode('similar-2', 'machine learning decision tree'),
    makeNode('unrelated', 'recipe chocolate cake'),
  ];

  beforeEach(async () => {
    const mod = await Test.createTestingModule({
      providers: [
        SmartConnectionsService,
        {
          provide: GraphRepository,
          useValue: {
            snapshotForUser: jest.fn().mockResolvedValue({ nodes, edges: [] }),
          },
        },
      ],
    }).compile();
    service = mod.get(SmartConnectionsService);
    repo = mod.get(GraphRepository) as jest.Mocked<GraphRepository>;
  });

  it('returns neighbours ranked by label-token Jaccard similarity', async () => {
    const results = await service.findSimilar('user-1', 'anchor', 3);

    expect(results.length).toBeGreaterThan(0);
    // anchor should not appear in its own similar list
    expect(results.find((r) => r.node.id === 'anchor')).toBeUndefined();
    // The two ML nodes should score higher than the recipe node
    const mlIds = results.slice(0, 2).map((r) => r.node.id);
    expect(mlIds).toEqual(expect.arrayContaining(['similar-1', 'similar-2']));
    // Scores should be descending
    for (let i = 1; i < results.length; i++) {
      expect(results[i].score).toBeLessThanOrEqual(results[i - 1].score);
    }
  });

  it('returns empty array when anchor node is not found', async () => {
    const results = await service.findSimilar('user-1', 'nonexistent', 5);
    expect(results).toEqual([]);
  });

  it('caps results at topN', async () => {
    const results = await service.findSimilar('user-1', 'anchor', 1);
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it('excludes soft-deleted nodes', async () => {
    const deletedNode: KGNode = {
      ...makeNode('deleted-ml', 'machine learning neural network'),
      deletedAt: new Date().toISOString(),
    };
    (repo.snapshotForUser as jest.Mock).mockResolvedValueOnce({
      nodes: [...nodes, deletedNode],
      edges: [],
    });
    const results = await service.findSimilar('user-1', 'anchor', 10);
    expect(results.find((r) => r.node.id === 'deleted-ml')).toBeUndefined();
  });
});
