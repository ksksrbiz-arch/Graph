import { Test } from '@nestjs/testing';
import { GraphRepository } from './graph.repository';
import { GraphService } from './graph.service';

describe('GraphService', () => {
  let service: GraphService;
  let repo: jest.Mocked<GraphRepository>;

  beforeEach(async () => {
    const mod = await Test.createTestingModule({
      providers: [
        GraphService,
        {
          provide: GraphRepository,
          useValue: {
            subgraph: jest.fn().mockResolvedValue({ nodes: [], edges: [] }),
            deleteNode: jest.fn().mockResolvedValue(true),
          },
        },
      ],
    }).compile();
    service = mod.get(GraphService);
    repo = mod.get(GraphRepository);
  });

  it('forwards subgraph requests to the repository', async () => {
    await service.subgraph('user-1', 'node-1', 3);
    expect(repo.subgraph).toHaveBeenCalledWith('user-1', 'node-1', 3);
  });

  it('forwards delete requests', async () => {
    await service.deleteNode('user-1', 'node-1');
    expect(repo.deleteNode).toHaveBeenCalledWith('user-1', 'node-1');
  });
});
