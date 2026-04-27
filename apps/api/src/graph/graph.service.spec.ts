import { Test } from '@nestjs/testing';
import { GraphRepository } from './graph.repository';
import { GraphService } from './graph.service';
import { SmartConnectionsService } from './smart-connections.service';
import { SearchService } from '../shared/meilisearch/search.service';
import { GraphGateway } from './graph.gateway';

describe('GraphService', () => {
  let service: GraphService;
  let repo: jest.Mocked<GraphRepository>;
  let smartConnections: jest.Mocked<SmartConnectionsService>;
  let search: jest.Mocked<SearchService>;

  beforeEach(async () => {
    const mod = await Test.createTestingModule({
      providers: [
        GraphService,
        {
          provide: GraphRepository,
          useValue: {
            subgraph: jest.fn().mockResolvedValue({ nodes: [], edges: [] }),
            deleteNode: jest.fn().mockResolvedValue(true),
            snapshotForUser: jest.fn().mockResolvedValue({ nodes: [], edges: [] }),
            upsertNode: jest.fn().mockResolvedValue(true),
            upsertEdge: jest.fn().mockResolvedValue(true),
            listNodes: jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
            getNode: jest.fn().mockResolvedValue(null),
          },
        },
        {
          provide: SmartConnectionsService,
          useValue: {
            findSimilar: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: SearchService,
          useValue: {
            indexNode: jest.fn().mockResolvedValue(undefined),
            deleteNode: jest.fn().mockResolvedValue(undefined),
            search: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: GraphGateway,
          useValue: {
            emitDelta: jest.fn(),
          },
        },
      ],
    }).compile();
    service = mod.get(GraphService);
    repo = mod.get(GraphRepository);
    smartConnections = mod.get(SmartConnectionsService);
    search = mod.get(SearchService);
  });

  it('forwards subgraph requests to the repository', async () => {
    await service.subgraph('user-1', 'node-1', 3);
    expect(repo.subgraph).toHaveBeenCalledWith('user-1', 'node-1', 3);
  });

  it('upsertNode writes to repo, indexes in search, and emits delta', async () => {
    const node = {
      id: 'n1',
      label: 'Hello',
      type: 'document' as const,
      sourceId: 'gmail' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},
    };
    await service.upsertNode('user-1', node);
    expect(repo.upsertNode).toHaveBeenCalledWith('user-1', node);
    expect(search.indexNode).toHaveBeenCalledWith('user-1', node);
  });

  it('upsertNode skips search indexing when repo returns false (no-op)', async () => {
    (repo.upsertNode as jest.Mock).mockResolvedValueOnce(false);
    const node = {
      id: 'n1',
      label: 'Hello',
      type: 'document' as const,
      sourceId: 'gmail' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},
    };
    await service.upsertNode('user-1', node);
    expect(search.indexNode).not.toHaveBeenCalled();
  });

  it('deleteNode removes from repo and search', async () => {
    await service.deleteNode('user-1', 'node-1');
    expect(repo.deleteNode).toHaveBeenCalledWith('user-1', 'node-1');
    expect(search.deleteNode).toHaveBeenCalledWith('user-1', 'node-1');
  });

  it('forwards findSimilar requests to SmartConnectionsService', async () => {
    await service.findSimilar('user-1', 'node-1', 5);
    expect(smartConnections.findSimilar).toHaveBeenCalledWith('user-1', 'node-1', 5);
  });

  it('listNodes delegates to repository', async () => {
    await service.listNodes('user-1', undefined, 50);
    expect(repo.listNodes).toHaveBeenCalledWith('user-1', undefined, 50, undefined);
  });

  it('searchNodes delegates to SearchService', async () => {
    await service.searchNodes('user-1', 'hello', 10);
    expect(search.search).toHaveBeenCalledWith('user-1', 'hello', 10);
  });
});
