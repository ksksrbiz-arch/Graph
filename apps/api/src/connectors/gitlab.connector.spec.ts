// Unit tests for GitLabConnector. Network is fully mocked via a stubbed global
// `fetch`; OAuthService is replaced with a minimal fake that returns a static
// access token. No real HTTP is performed (NO network).

import { KGEdgeSchema, KGNodeSchema, type ConnectorConfig } from '@pkg/shared';
import { GitLabConnector } from './gitlab.connector';
import type { OAuthService } from '../oauth/oauth.service';
import type { RawItem } from './base.connector';

// ── helpers ───────────────────────────────────────────────────

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

const ME = { id: 1, username: 'octo', name: 'Octo Cat' };

const PROJECT = {
  id: 99,
  path_with_namespace: 'octo/widgets',
  web_url: 'https://gitlab.com/octo/widgets',
};

function makeConfig(): ConnectorConfig {
  return {
    id: 'gitlab',
    userId: 'user-1',
    enabled: true,
    credentials: { ciphertext: 'x', iv: 'y', keyId: 'k' },
    syncIntervalMinutes: 30,
  };
}

function makeConnector(): GitLabConnector {
  const oauth = {
    decryptCredentials: () => ({ accessToken: 'glpat-test-token' }),
  } as unknown as OAuthService;
  return new GitLabConnector(oauth);
}

/**
 * Build a fetch mock that routes by URL. `/user` and `/projects/:id` always
 * resolve to the static fixtures; `/events` returns the supplied event pages in
 * order (one array per call), then empty arrays.
 */
function mockFetch(eventPages: unknown[][]): jest.Mock {
  let eventCall = 0;
  return jest.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/user')) return Promise.resolve(jsonResponse(ME));
    if (url.includes('/projects/')) {
      return Promise.resolve(jsonResponse(PROJECT));
    }
    if (url.includes('/events')) {
      const page = eventPages[eventCall] ?? [];
      eventCall += 1;
      return Promise.resolve(jsonResponse(page));
    }
    throw new Error(`unexpected fetch to ${url}`);
  });
}

async function collect(
  gen: AsyncGenerator<RawItem>,
): Promise<RawItem[]> {
  const out: RawItem[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

const SINCE = new Date('2026-06-01T00:00:00.000Z');
const NEWER = '2026-06-10T12:00:00.000Z';

const PUSH_EVENT = {
  id: 5001,
  project_id: 99,
  action_name: 'pushed to',
  created_at: NEWER,
  author: { id: 1, username: 'octo' },
  push_data: {
    commit_count: 2,
    ref: 'main',
    commit_to: 'abcdef0123456789',
    commit_title: 'Fix the thing\nbody line',
  },
};

const ISSUE_EVENT = {
  id: 5002,
  project_id: 99,
  action_name: 'closed',
  target_type: 'Issue',
  target_iid: 42,
  target_title: 'A broken widget',
  created_at: NEWER,
  author: { id: 1, username: 'octo' },
};

const MR_EVENT = {
  id: 5003,
  project_id: 99,
  action_name: 'merged',
  target_type: 'MergeRequest',
  target_iid: 7,
  target_title: 'Add new widget',
  created_at: NEWER,
  author: { id: 1, username: 'octo' },
};

const GENERIC_EVENT = {
  id: 5004,
  project_id: 99,
  action_name: 'joined',
  created_at: NEWER,
  author: { id: 1, username: 'octo' },
};

// ── tests ─────────────────────────────────────────────────────

describe('GitLabConnector', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it('exposes the gitlab id and oauth scopes', () => {
    const c = makeConnector();
    expect(c.id).toBe('gitlab');
    expect(c.authType).toBe('oauth');
    expect(c.oauthScopes).toContain('read_api');
  });

  it('yields one raw item per event newer than `since`', async () => {
    global.fetch = mockFetch([[PUSH_EVENT, ISSUE_EVENT]]) as unknown as typeof fetch;
    const items = await collect(makeConnector().fetchIncremental(makeConfig(), SINCE));
    expect(items).toHaveLength(2);
    expect(items[0]?.externalId).toBe('pushed to:5001');
    expect(items[1]?.externalId).toBe('closed:5002');
  });

  it('stops at the first event older than `since` (incremental cursor)', async () => {
    const old = { ...PUSH_EVENT, id: 6000, created_at: '2026-05-01T00:00:00.000Z' };
    global.fetch = mockFetch([[ISSUE_EVENT, old, MR_EVENT]]) as unknown as typeof fetch;
    const items = await collect(makeConnector().fetchIncremental(makeConfig(), SINCE));
    // ISSUE_EVENT is newer, then we hit the old one and stop before MR_EVENT.
    expect(items).toHaveLength(1);
    expect(items[0]?.externalId).toBe('closed:5002');
  });

  it('stops paging when the rate limit is nearly exhausted', async () => {
    const fetchMock = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/user')) return Promise.resolve(jsonResponse(ME));
      if (url.includes('/projects/')) return Promise.resolve(jsonResponse(PROJECT));
      // Full page so it would page again, but rate-limit header forces a stop.
      // GitLab sends `RateLimit-Remaining` (no `x-` prefix), which the shared
      // readRateLimit() does NOT parse — the connector reads it natively.
      return Promise.resolve(
        jsonResponse([PUSH_EVENT], {
          headers: {
            'ratelimit-remaining': '1',
            'content-type': 'application/json',
          },
        }),
      );
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    await collect(makeConnector().fetchIncremental(makeConfig(), SINCE));
    const eventCalls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes('/events'),
    );
    expect(eventCalls).toHaveLength(1);
  });

  it('returns early on a non-2xx events response', async () => {
    const fetchMock = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/user')) return Promise.resolve(jsonResponse(ME));
      return Promise.resolve(new Response('boom', { status: 500 }));
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const items = await collect(makeConnector().fetchIncremental(makeConfig(), SINCE));
    expect(items).toHaveLength(0);
  });

  it('caches project lookups across events in the same project', async () => {
    const fetchMock = mockFetch([[PUSH_EVENT, ISSUE_EVENT, MR_EVENT]]);
    global.fetch = fetchMock as unknown as typeof fetch;
    await collect(makeConnector().fetchIncremental(makeConfig(), SINCE));
    const projectCalls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes('/projects/'),
    );
    expect(projectCalls).toHaveLength(1);
  });

  it('throws when /user is missing a username', async () => {
    const fetchMock = jest.fn((input: RequestInfo | URL) => {
      if (String(input).includes('/user')) {
        return Promise.resolve(jsonResponse({ id: 1 }));
      }
      return Promise.resolve(jsonResponse([]));
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(
      collect(makeConnector().fetchIncremental(makeConfig(), SINCE)),
    ).rejects.toThrow(/username/);
  });

  // ── transform ──

  function rawFor(event: unknown): RawItem {
    return {
      externalId: 'x',
      raw: {
        event,
        project: { id: 99, path: 'octo/widgets', webUrl: PROJECT.web_url },
        actor: 'octo',
      },
    };
  }

  function expectValid(result: { node: unknown; edges: unknown[] }): void {
    expect(KGNodeSchema.safeParse(result.node).success).toBe(true);
    for (const edge of result.edges) {
      expect(KGEdgeSchema.safeParse(edge).success).toBe(true);
    }
  }

  it('maps a push event to a commit node with AUTHORED_BY + COMMITS_TO', () => {
    const { node, edges } = makeConnector().transform(rawFor(PUSH_EVENT));
    expect(node.type).toBe('commit');
    expect(node.label).toBe('Fix the thing');
    expect(node.sourceUrl).toContain('/-/commit/abcdef0123456789');
    expect(edges.map((e) => e.relation).sort()).toEqual(
      ['AUTHORED_BY', 'COMMITS_TO'].sort(),
    );
    expectValid({ node, edges });
  });

  it('maps a closed issue event to an issue node with a CLOSES edge', () => {
    const { node, edges } = makeConnector().transform(rawFor(ISSUE_EVENT));
    expect(node.type).toBe('issue');
    expect(node.label).toBe('A broken widget');
    expect(node.sourceUrl).toContain('/-/issues/42');
    const relations = edges.map((e) => e.relation);
    expect(relations).toContain('AUTHORED_BY');
    expect(relations).toContain('PART_OF');
    expect(relations).toContain('CLOSES');
    expectValid({ node, edges });
  });

  it('maps a merge-request event to a pull_request node', () => {
    const { node, edges } = makeConnector().transform(rawFor(MR_EVENT));
    expect(node.type).toBe('pull_request');
    expect(node.label).toBe('Add new widget');
    expect(node.sourceUrl).toContain('/-/merge_requests/7');
    const relations = edges.map((e) => e.relation);
    expect(relations).toContain('AUTHORED_BY');
    expect(relations).toContain('PART_OF');
    expect(relations).toContain('REFERENCES');
    expectValid({ node, edges });
  });

  it('maps unknown events to a repository node with RELATED_TO', () => {
    const { node, edges } = makeConnector().transform(rawFor(GENERIC_EVENT));
    expect(node.type).toBe('repository');
    expect(edges).toHaveLength(1);
    expect(edges[0]?.relation).toBe('RELATED_TO');
    expectValid({ node, edges });
  });

  it('produces deterministic node ids for the same upstream item', () => {
    const a = makeConnector().transform(rawFor(PUSH_EVENT));
    const b = makeConnector().transform(rawFor(PUSH_EVENT));
    expect(a.node.id).toBe(b.node.id);
  });

  it('falls back to a non-empty label when commit_title is empty', () => {
    const empty = { ...PUSH_EVENT, push_data: { ...PUSH_EVENT.push_data, commit_title: '' } };
    const { node } = makeConnector().transform(rawFor(empty));
    expect(node.label.length).toBeGreaterThan(0);
    expect(KGNodeSchema.safeParse(node).success).toBe(true);
  });

  it('falls back to a non-empty label when an issue target_title is empty', () => {
    const empty = { ...ISSUE_EVENT, target_title: '' };
    const { node } = makeConnector().transform(rawFor(empty));
    expect(node.label).toBe('issue #42');
    expect(KGNodeSchema.safeParse(node).success).toBe(true);
  });

  it('falls back to a non-empty label when an MR target_title is empty', () => {
    const empty = { ...MR_EVENT, target_title: '' };
    const { node } = makeConnector().transform(rawFor(empty));
    expect(node.label).toBe('merge request !7');
    expect(KGNodeSchema.safeParse(node).success).toBe(true);
  });
});
