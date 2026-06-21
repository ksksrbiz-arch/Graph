import { KGEdgeSchema, KGNodeSchema } from '@pkg/shared';
import type { ConnectorConfig } from '@pkg/shared';
import { TodoistConnector } from './todoist.connector';
import type { RawItem } from './base.connector';
import type { OAuthService } from '../oauth/oauth.service';

// A throwaway OAuthService whose decryptCredentials just hands back a token.
const oauthStub = {
  decryptCredentials: () => ({ accessToken: 'tok-123' }),
} as unknown as OAuthService;

const config: ConnectorConfig = {
  id: 'todoist',
  userId: 'user-1',
  enabled: true,
  credentials: { ciphertext: 'x', iv: 'y', keyId: 'k' },
  syncIntervalMinutes: 30,
};

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

/** Route the two REST endpoints to canned payloads. NO network. */
function mockFetch(
  routes: { projects?: unknown; tasks?: unknown },
  opts: { tasksInit?: ResponseInit } = {},
): jest.Mock {
  return jest.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/projects')) {
      return Promise.resolve(jsonResponse(routes.projects ?? []));
    }
    if (url.includes('/tasks')) {
      return Promise.resolve(
        jsonResponse(routes.tasks ?? [], opts.tasksInit),
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

async function drain(
  gen: AsyncGenerator<RawItem>,
): Promise<RawItem[]> {
  const out: RawItem[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

describe('TodoistConnector', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  const connector = new TodoistConnector(oauthStub);

  const sampleProject = {
    id: '220474322',
    name: 'Inbox',
    color: 'grey',
    is_favorite: false,
    is_inbox_project: true,
    url: 'https://todoist.com/showProject?id=220474322',
  };

  const sampleTask = {
    id: '2995104339',
    content: 'Buy milk',
    description: 'whole milk',
    project_id: '220474322',
    section_id: null,
    parent_id: null,
    priority: 3,
    is_completed: false,
    labels: ['errands'],
    due: { date: '2026-07-01', string: 'Jul 1', is_recurring: false },
    url: 'https://todoist.com/showTask?id=2995104339',
    created_at: '2026-06-20T10:00:00.000000Z',
  };

  it('fetches projects then tasks and tags each raw item with its kind', async () => {
    global.fetch = mockFetch({
      projects: [sampleProject],
      tasks: [sampleTask],
    }) as unknown as typeof fetch;

    const items = await drain(
      connector.fetchIncremental(config, new Date('2026-01-01T00:00:00Z')),
    );

    expect(items).toHaveLength(2);
    expect(items[0].externalId).toBe('project:220474322');
    expect(items[1].externalId).toBe('task:2995104339');
    // The task carries the resolved project name for metadata enrichment.
    const taskRaw = items[1].raw as { kind: string; projectName?: string };
    expect(taskRaw.kind).toBe('task');
    expect(taskRaw.projectName).toBe('Inbox');
  });

  it('skips tasks created at or before the `since` watermark', async () => {
    const stale = { ...sampleTask, id: '111', created_at: '2025-01-01T00:00:00Z' };
    const fresh = { ...sampleTask, id: '222', created_at: '2026-06-20T00:00:00Z' };
    global.fetch = mockFetch({
      projects: [],
      tasks: [stale, fresh],
    }) as unknown as typeof fetch;

    const items = await drain(
      connector.fetchIncremental(config, new Date('2026-01-01T00:00:00Z')),
    );
    const ids = items.map((i) => i.externalId);
    expect(ids).toEqual(['task:222']);
  });

  it('transforms a task into a valid `task` KGNode with PART_OF edge to its project', () => {
    const raw: RawItem = {
      externalId: 'task:2995104339',
      raw: { kind: 'task', task: sampleTask, projectName: 'Inbox' },
    };
    const { node, edges } = connector.transform(raw);

    expect(node.type).toBe('task');
    expect(node.label).toBe('Buy milk');
    expect(node.sourceId).toBe('todoist');
    expect(node.metadata.project).toBe('Inbox');
    expect(node.metadata.priority).toBe(3);
    expect(node.metadata.completed).toBe(false);
    expect(node.metadata.due).toBe('2026-07-01');
    expect(node.metadata.labels).toEqual(['errands']);
    expect(KGNodeSchema.safeParse(node).success).toBe(true);

    expect(edges).toHaveLength(1);
    expect(edges[0].relation).toBe('PART_OF');
    expect(edges[0].target).toBe(
      // deterministic project id the node should point at
      connector.transform({
        externalId: 'project:220474322',
        raw: { kind: 'project', project: sampleProject },
      }).node.id,
    );
    expect(edges.every((e) => KGEdgeSchema.safeParse(e).success)).toBe(true);
  });

  it('emits two PART_OF edges for a sub-task (parent task + project)', () => {
    const subTask = { ...sampleTask, id: '333', parent_id: '2995104339' };
    const { edges } = connector.transform({
      externalId: 'task:333',
      raw: { kind: 'task', task: subTask },
    });
    expect(edges).toHaveLength(2);
    expect(edges.every((e) => e.relation === 'PART_OF')).toBe(true);
  });

  it('transforms a project into a valid container node, nested under its parent', () => {
    const nested = { ...sampleProject, id: '999', name: 'Work', parent_id: '220474322' };
    const { node, edges } = connector.transform({
      externalId: 'project:999',
      raw: { kind: 'project', project: nested },
    });
    expect(node.label).toBe('Work');
    expect(node.metadata.kind).toBe('project');
    expect(KGNodeSchema.safeParse(node).success).toBe(true);
    expect(edges).toHaveLength(1);
    expect(edges[0].relation).toBe('PART_OF');
  });

  it('produces stable node ids across re-syncs (idempotency, Rule 12)', () => {
    const a = connector.transform({
      externalId: 'task:2995104339',
      raw: { kind: 'task', task: sampleTask },
    }).node.id;
    const b = connector.transform({
      externalId: 'task:2995104339',
      raw: { kind: 'task', task: sampleTask },
    }).node.id;
    expect(a).toBe(b);
  });

  it('returns an empty stream when the tasks endpoint errors (no throw)', async () => {
    global.fetch = mockFetch(
      { projects: [], tasks: [] },
      { tasksInit: { status: 500 } },
    ) as unknown as typeof fetch;

    const items = await drain(
      connector.fetchIncremental(config, new Date('2026-01-01T00:00:00Z')),
    );
    expect(items).toEqual([]);
  });

  it('sends a Bearer token to the Todoist REST API', async () => {
    const spy = mockFetch({ projects: [], tasks: [] });
    global.fetch = spy as unknown as typeof fetch;

    await drain(
      connector.fetchIncremental(config, new Date('2026-01-01T00:00:00Z')),
    );

    const calls = spy.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const init = calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer tok-123');
  });
});
