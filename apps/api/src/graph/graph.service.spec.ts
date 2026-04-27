import { Test } from '@nestjs/testing';
import { GraphRepository } from './graph.repository';
import { GraphService } from './graph.service';
import { SmartConnectionsService } from './smart-connections.service';

describe('GraphService', () => {
  let service: GraphService;
  let repo: jest.Mocked<GraphRepository>;
  let smartConnections: jest.Mocked<SmartConnectionsService>;

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
          },
        },
        {
          provide: SmartConnectionsService,
          useValue: {
            findSimilar: jest.fn().mockResolvedValue([]),
          },
        },
      ],
    }).compile();
    service = mod.get(GraphService);
    repo = mod.get(GraphRepository);
    smartConnections = mod.get(SmartConnectionsService);
  });

  it('forwards subgraph requests to the repository', async () => {
    await service.subgraph('user-1', 'node-1', 3);
    expect(repo.subgraph).toHaveBeenCalledWith('user-1', 'node-1', 3);
  });

  it('forwards delete requests', async () => {
    await service.deleteNode('user-1', 'node-1');
    expect(repo.deleteNode).toHaveBeenCalledWith('user-1', 'node-1');
  });

  it('forwards findSimilar requests to SmartConnectionsService', async () => {
    await service.findSimilar('user-1', 'node-1', 5);
    expect(smartConnections.findSimilar).toHaveBeenCalledWith('user-1', 'node-1', 5);
  });
});
