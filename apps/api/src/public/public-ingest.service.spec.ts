// The service validates env at construction (loadEnv). Provide the minimum the
// schema requires so this unit test is self-contained (CI sets these too).
process.env.POSTGRES_URL ??= 'postgresql://pkg:pkg@localhost:5432/pkg';
process.env.NEO4J_URI ??= 'bolt://localhost:7687';
process.env.NEO4J_USER ??= 'neo4j';
process.env.NEO4J_PASSWORD ??= 'password';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.MEILI_HOST ??= 'http://localhost:7700';
process.env.MEILI_MASTER_KEY ??= 'test-master-key';
process.env.JWT_SECRET ??= 'test-jwt-secret-32-bytes-minimum-xx';
process.env.KEK_BASE64 ??= 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

import type { KGEdge, KGNode } from '@pkg/shared';
import { PublicIngestService } from './public-ingest.service';
import type { GraphService } from '../graph/graph.service';
import type { SensoryService } from '../brain/sensory.service';
import type { BrainService } from '../brain/brain.service';

function setup() {
  const nodes: KGNode[] = [];
  const edges: KGEdge[] = [];
  const graph = {
    upsertNode: jest.fn(async (_userId: string, node: KGNode) => {
      nodes.push(node);
      return true;
    }),
    upsertEdge: jest.fn(async (_userId: string, edge: KGEdge) => {
      edges.push(edge);
      return true;
    }),
  } as unknown as GraphService;
  const sensory = { perceive: jest.fn() } as unknown as SensoryService;
  const brain = { isRunning: jest.fn(() => false) } as unknown as BrainService;
  const svc = new PublicIngestService(graph, sensory, brain);
  return { svc, nodes, edges };
}

describe('PublicIngestService.ingestGraph', () => {
  it('sanitises nodes: keeps id/label, coerces unknown type to note, fills defaults', async () => {
    const { svc, nodes } = setup();
    const res = await svc.ingestGraph(
      'local',
      [
        { id: 'a', label: 'Alpha', type: 'concept' },
        { id: 'b', type: 'totally-bogus' }, // unknown type → note; label defaults to id
        { label: 'no id' }, // dropped (no id)
        'not-an-object', // dropped
      ],
      [],
      'client',
    );

    expect(res.nodes).toBe(2);
    expect(res.skippedNodes).toBe(2);
    const a = nodes.find((n) => n.id === 'a');
    const b = nodes.find((n) => n.id === 'b');
    expect(a?.type).toBe('concept');
    expect(b?.type).toBe('note');
    expect(b?.label).toBe('b');
    expect(a?.createdAt).toBeTruthy();
    expect(a?.metadata).toEqual({});
    expect(a?.sourceId).toBe('client');
  });

  it('drops dangling edges, self-loops, and coerces unknown relations', async () => {
    const { svc, edges } = setup();
    const res = await svc.ingestGraph(
      'local',
      [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
      [
        { source: 'a', target: 'b', relation: 'LINKS_TO' },
        { source: 'a', target: 'b', relation: 'made-up' }, // → RELATED_TO
        { source: 'a', target: 'missing' }, // dangling → dropped
        { source: 'a', target: 'a' }, // self-loop → dropped
      ],
    );

    expect(res.edges).toBe(2);
    expect(res.skippedEdges).toBe(2);
    expect(edges.map((e) => e.relation).sort()).toEqual(['LINKS_TO', 'RELATED_TO']);
    expect(edges.every((e) => e.weight >= 0 && e.weight <= 1)).toBe(true);
  });
});
