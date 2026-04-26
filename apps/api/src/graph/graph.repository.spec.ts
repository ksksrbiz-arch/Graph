// Repository-level idempotency tests. The Neo4j driver is mocked at the
// session boundary so we exercise only the fingerprint cache + Cypher dispatch
// logic.

import type { KGEdge, KGNode } from '@pkg/shared';
import { GraphRepository } from './graph.repository';

interface MockSession {
  run: jest.Mock;
  close: jest.Mock;
}

function makeDriver(): { driver: { session: jest.Mock }; sessions: MockSession[] } {
  const sessions: MockSession[] = [];
  const driver = {
    session: jest.fn().mockImplementation(() => {
      const s: MockSession = {
        run: jest.fn().mockResolvedValue({ records: [] }),
        close: jest.fn().mockResolvedValue(undefined),
      };
      sessions.push(s);
      return s;
    }),
  };
  return { driver, sessions };
}

const baseNode: KGNode = {
  id: '00000000-0000-4000-8000-000000000001',
  label: 'Hello',
  type: 'document',
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
  metadata: {},
  sourceId: 'gmail',
};

const baseEdge: KGEdge = {
  id: '00000000-0000-4000-8000-000000000002',
  source: 'a',
  target: 'b',
  relation: 'MENTIONS',
  weight: 0.5,
  inferred: false,
  createdAt: '2024-01-01T00:00:00.000Z',
  metadata: {},
};

describe('GraphRepository idempotency', () => {
  it('upsertNode returns true on first write and false on identical replays', async () => {
    const { driver, sessions } = makeDriver();
    const repo = new GraphRepository(driver as never);

    const first = await repo.upsertNode('user-1', baseNode);
    const second = await repo.upsertNode('user-1', baseNode);

    expect(first).toBe(true);
    expect(second).toBe(false);
    // Only one session (and one .run) for the de-duplicated pair.
    expect(sessions.length).toBe(1);
    expect(sessions[0]!.run).toHaveBeenCalledTimes(1);
  });

  it('upsertNode hits Neo4j again when the payload changes', async () => {
    const { driver, sessions } = makeDriver();
    const repo = new GraphRepository(driver as never);

    await repo.upsertNode('user-1', baseNode);
    await repo.upsertNode('user-1', { ...baseNode, label: 'Hello (updated)' });

    expect(sessions.length).toBe(2);
  });

  it('upsertNode treats different users as independent', async () => {
    const { driver, sessions } = makeDriver();
    const repo = new GraphRepository(driver as never);

    await repo.upsertNode('user-1', baseNode);
    await repo.upsertNode('user-2', baseNode);

    expect(sessions.length).toBe(2);
  });

  it('upsertEdge returns true on first write and false on identical replays', async () => {
    const { driver, sessions } = makeDriver();
    const repo = new GraphRepository(driver as never);

    const first = await repo.upsertEdge('user-1', baseEdge);
    const second = await repo.upsertEdge('user-1', baseEdge);

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(sessions.length).toBe(1);
  });

  it('deleteNode invalidates the fingerprint so a recreate is treated as fresh', async () => {
    const { driver, sessions } = makeDriver();
    const repo = new GraphRepository(driver as never);

    await repo.upsertNode('user-1', baseNode);
    await repo.deleteNode('user-1', baseNode.id);
    const recreated = await repo.upsertNode('user-1', baseNode);

    expect(recreated).toBe(true);
    // 1 upsert + 1 delete + 1 upsert = 3 sessions.
    expect(sessions.length).toBe(3);
  });

  it('deleteAllForUser purges every fingerprint scoped to that user', async () => {
    const { driver, sessions } = makeDriver();
    const repo = new GraphRepository(driver as never);

    await repo.upsertNode('user-1', baseNode);
    await repo.deleteAllForUser('user-1');
    const recreated = await repo.upsertNode('user-1', baseNode);

    expect(recreated).toBe(true);
    expect(sessions.length).toBe(3); // upsert, deleteAll, upsert
  });
});
