// Controller-level tests. GraphService is mocked so we test only the HTTP
// layer — parameter extraction, guard application, and status codes.

import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { GraphController } from './graph.controller';
import { GraphService } from './graph.service';

const MOCK_USER = { sub: 'user-1' };

function makeRequest(): { user: { sub: string } } {
  return { user: MOCK_USER };
}

describe('GraphController', () => {
  let controller: GraphController;
  let service: jest.Mocked<
    Pick<GraphService, 'listNodes' | 'getNode' | 'subgraph' | 'searchNodes' | 'findSimilar' | 'deleteNode'>
  >;

  beforeEach(async () => {
    const mod = await Test.createTestingModule({
      controllers: [GraphController],
      providers: [
        {
          provide: GraphService,
          useValue: {
            listNodes: jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
            getNode: jest.fn().mockResolvedValue({ id: 'n1', label: 'Test' }),
            subgraph: jest.fn().mockResolvedValue({ nodes: [], edges: [] }),
            searchNodes: jest.fn().mockResolvedValue([]),
            findSimilar: jest.fn().mockResolvedValue([]),
            deleteNode: jest.fn().mockResolvedValue(true),
          },
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = mod.get(GraphController);
    service = mod.get(GraphService);
  });

  describe('listNodes', () => {
    it('delegates to GraphService.listNodes with defaults', async () => {
      await controller.listNodes(makeRequest() as never);
      expect(service.listNodes).toHaveBeenCalledWith('user-1', undefined, 100, undefined);
    });

    it('passes cursor, limit and type query params', async () => {
      await controller.listNodes(makeRequest() as never, 'abc', '50', 'note');
      expect(service.listNodes).toHaveBeenCalledWith('user-1', 'abc', 50, 'note');
    });
  });

  describe('getNode', () => {
    it('returns the node from GraphService', async () => {
      const result = await controller.getNode(makeRequest() as never, 'n1');
      expect(result).toMatchObject({ id: 'n1' });
    });

    it('re-throws NotFoundException when node does not exist', async () => {
      (service.getNode as jest.Mock).mockRejectedValueOnce(new NotFoundException());
      await expect(controller.getNode(makeRequest() as never, 'missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('subgraph', () => {
    it('passes rootId and depth to service', async () => {
      await controller.subgraph(makeRequest() as never, 'root-1', '3');
      expect(service.subgraph).toHaveBeenCalledWith('user-1', 'root-1', 3);
    });
  });

  describe('search', () => {
    it('passes q and limit to service', async () => {
      await controller.search(makeRequest() as never, 'hello world', '15');
      expect(service.searchNodes).toHaveBeenCalledWith('user-1', 'hello world', 15);
    });
  });

  describe('deleteNode', () => {
    it('calls GraphService.deleteNode and returns void (204)', async () => {
      await expect(controller.deleteNode(makeRequest() as never, 'n1')).resolves.toBeUndefined();
      expect(service.deleteNode).toHaveBeenCalledWith('user-1', 'n1');
    });
  });
});
