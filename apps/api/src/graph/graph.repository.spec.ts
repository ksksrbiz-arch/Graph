// Repository-level tests. The Neo4j driver is mocked at the session boundary
// so we exercise the fingerprint cache + Cypher dispatch logic + read path
// method contract.

import type { KGEdge, KGNode } from '@pkg/shared';
import { GraphRepository } from './graph.repository';

interface MockSession {
  run: jest.Mock;
  close: jest.Mock;
}

function makeDriver(
  defaultRecords: Record<string, unknown>[] = [],
): { driver: { session: jest.Mock }; sessions: MockSession[] } {
  const sessions: MockSession[] = [];
  const driver = {
    session: jest.fn().mockImplementation(() => {
      const s: MockSession = {
        run: jest.fn().mockResolvedValue({ records: defaultRecords }),
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

// ── helper: build a fake Neo4j node record ────────────────────────────────────

function makeFakeNeo4jRecord(
  fields: Record<string, unknown>,
): { get: (key: string) => unknown } {
  return { get: (key: string) => fields[key] };
}

function makeFakeNodeNeo4j(partial: Partial<KGNode> = {}): {
  properties: Record<string, unknown>;
} {
  return {
    properties: {
      id: partial.id ?? '00000000-0000-4000-8000-000000000001',
      label: partial.label ?? 'Hello',
      type: partial.type ?? 'document',
      sourceId: partial.sourceId ?? 'gmail',
      sourceUrl: partial.sourceUrl ?? null,
      createdAt: partial.createdAt ?? '2024-01-01T00:00:00.000Z',
      updatedAt: partial.updatedAt ?? '2024-01-01T00:00:00.000Z',
      metadataJson: JSON.stringify(partial.metadata ?? {}),
    },
  };
}

// ── subgraph ─────────────────────────────────────────────────────────────────

describe('GraphRepository.subgraph', () => {
  it('returns empty subgraph when no records', async () => {
    const { driver } = makeDriver([]);
    const repo = new GraphRepository(driver as never);
    const result = await repo.subgraph('user-1', 'root-1', 2);
    expect(result).toEqual({ nodes: [], edges: [] });
  });

  it('returns nodes and edges from the first record', async () => {
    const fakeNodes = [makeFakeNodeNeo4j()];
    const fakeEdges: unknown[] = [];
    const record = makeFakeNeo4jRecord({ nodes: fakeNodes, edges: fakeEdges });
    const { driver, sessions } = makeDriver([record as never]);
    const repo = new GraphRepository(driver as never);
    const result = await repo.subgraph('user-1', 'root-1', 2);
    expect(result.nodes).toHaveLength(1);
    expect(result.edges).toHaveLength(0);
    expect(sessions[0]!.run).toHaveBeenCalledTimes(1);
  });

  it('clamps depth to [1,4]', async () => {
    const { driver, sessions } = makeDriver([]);
    const repo = new GraphRepository(driver as never);
    await repo.subgraph('user-1', 'root', 10);
    const cypher: string = sessions[0]!.run.mock.calls[0][0];
    // The safe depth 4 should appear in the query but 10 should not.
    expect(cypher).toContain('1..4');
  });
});

// ── snapshotForUser ───────────────────────────────────────────────────────────

describe('GraphRepository.snapshotForUser', () => {
  it('returns mapped nodes and edges', async () => {
    const { driver, sessions } = makeDriver([]);
    // First run call → nodes, second → edges.
    const nodeRecord = { get: (k: string) => (k === 'n' ? makeFakeNodeNeo4j() : null) };
    const edgeRecord = {
      get: (k: string) => {
        const map: Record<string, unknown> = {
          id: 'e1',
          source: 'a',
          target: 'b',
          relation: 'MENTIONS',
          weight: 0.5,
          inferred: false,
          createdAt: '2024-01-01T00:00:00.000Z',
          metadataJson: null,
        };
        return map[k] ?? null;
      },
    };
    sessions[0] = {
      run: jest
        .fn()
        .mockResolvedValueOnce({ records: [nodeRecord] })
        .mockResolvedValueOnce({ records: [edgeRecord] }),
      close: jest.fn().mockResolvedValue(undefined),
    };
    (driver.session as jest.Mock).mockReturnValue(sessions[0]);

    const repo = new GraphRepository(driver as never);
    const { nodes, edges } = await repo.snapshotForUser('user-1');
    expect(nodes).toHaveLength(1);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.relation).toBe('MENTIONS');
  });
});

// ── listNodes ─────────────────────────────────────────────────────────────────

describe('GraphRepository.listNodes', () => {
  it('returns empty page when no records', async () => {
    const { driver } = makeDriver([]);
    const repo = new GraphRepository(driver as never);
    const page = await repo.listNodes('user-1');
    expect(page.items).toHaveLength(0);
    expect(page.nextCursor).toBeNull();
  });

  it('sets nextCursor when more items exist than the limit', async () => {
    // Return limit+1 records to indicate hasMore.
    const records = Array.from({ length: 3 }, (_, i) =>
      ({ get: (k: string) => (k === 'n' ? makeFakeNodeNeo4j({ id: `id-${i}`, createdAt: `2024-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z` }) : null) }),
    );
    const { driver } = makeDriver(records as never);
    const repo = new GraphRepository(driver as never);
    const page = await repo.listNodes('user-1', undefined, 2);
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
  });

  it('passes type filter through to Cypher when provided', async () => {
    const { driver, sessions } = makeDriver([]);
    const repo = new GraphRepository(driver as never);
    await repo.listNodes('user-1', undefined, 100, 'note');
    const cypher: string = sessions[0]!.run.mock.calls[0][0];
    expect(cypher).toContain('n.type = $type');
  });

  it('ignores invalid cursors gracefully', async () => {
    const { driver, sessions } = makeDriver([]);
    const repo = new GraphRepository(driver as never);
    // "not-valid-base64url" decodes to a non-date string so decodeCursor returns null.
    await repo.listNodes('user-1', 'not-valid-cursor');
    const cypher: string = sessions[0]!.run.mock.calls[0][0];
    expect(cypher).not.toContain('n.createdAt >');
  });
});

// ── getNode ───────────────────────────────────────────────────────────────────

describe('GraphRepository.getNode', () => {
  it('returns null when no record found', async () => {
    const { driver } = makeDriver([]);
    const repo = new GraphRepository(driver as never);
    const result = await repo.getNode('user-1', 'nonexistent');
    expect(result).toBeNull();
  });

  it('returns a mapped KGNode when record exists', async () => {
    const record = { get: (k: string) => (k === 'n' ? makeFakeNodeNeo4j() : null) };
    const { driver } = makeDriver([record as never]);
    const repo = new GraphRepository(driver as never);
    const result = await repo.getNode('user-1', '00000000-0000-4000-8000-000000000001');
    expect(result).not.toBeNull();
    expect(result!.label).toBe('Hello');
    expect(result!.type).toBe('document');
  });
});
