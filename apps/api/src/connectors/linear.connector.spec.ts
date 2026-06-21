// Unit tests for the Linear connector. No network: `fetch` is stubbed and the
// OAuthService is a thin mock that returns a fixed access token.

import type { ConnectorConfig } from '@pkg/shared';
import { LinearConnector } from './linear.connector';
import type { RawItem } from './base.connector';
import type { OAuthService } from '../oauth/oauth.service';

interface LinearIssueFixture {
  id: string;
  identifier?: string;
  title?: string;
  url?: string;
  priority?: number;
  priorityLabel?: string;
  createdAt: string;
  updatedAt: string;
  state?: { id: string; name: string; type: string };
  assignee?: { id: string; name?: string; displayName?: string };
  creator?: { id: string; name?: string; displayName?: string };
  team?: { id: string; name?: string; key?: string };
  project?: { id: string; name?: string };
}

function makeConfig(): ConnectorConfig {
  return {
    id: 'linear',
    userId: 'user-1',
    enabled: true,
    credentials: { ciphertext: 'x', iv: 'y', tag: 'z' } as unknown as ConnectorConfig['credentials'],
    syncIntervalMinutes: 60,
  };
}

function makeOAuth(): OAuthService {
  return {
    decryptCredentials: () => ({ accessToken: 'lin_test_token' }),
  } as unknown as OAuthService;
}

/** Build a Headers-like object for rate-limit reads. */
function rateHeaders(remaining?: number): Headers {
  const h = new Headers();
  if (remaining !== undefined) {
    h.set('x-ratelimit-requests-remaining', String(remaining));
  }
  return h;
}

function graphqlResponse(body: unknown, init?: { ok?: boolean; status?: number; headers?: Headers }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    headers: init?.headers ?? new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function issuesPayload(
  nodes: LinearIssueFixture[],
  pageInfo: { hasNextPage: boolean; endCursor: string | null },
): unknown {
  return { data: { issues: { nodes, pageInfo } } };
}

const baseIssue: LinearIssueFixture = {
  id: 'issue-1',
  identifier: 'ENG-1',
  title: 'Fix the thing',
  url: 'https://linear.app/acme/issue/ENG-1',
  priority: 2,
  priorityLabel: 'High',
  createdAt: '2026-06-20T10:00:00.000Z',
  updatedAt: '2026-06-21T10:00:00.000Z',
  state: { id: 'state-1', name: 'In Progress', type: 'started' },
  assignee: { id: 'user-a', name: 'Ada Lovelace', displayName: 'ada' },
  creator: { id: 'user-c', name: 'Charles Babbage', displayName: 'charles' },
  team: { id: 'team-1', name: 'Engineering', key: 'ENG' },
  project: { id: 'proj-1', name: 'Q3 Roadmap' },
};

describe('LinearConnector', () => {
  let connector: LinearConnector;
  let fetchMock: jest.Mock;
  const originalFetch = global.fetch;

  beforeEach(() => {
    connector = new LinearConnector(makeOAuth());
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  async function collect(since: Date): Promise<RawItem[]> {
    const out: RawItem[] = [];
    for await (const item of connector.fetchIncremental(makeConfig(), since)) {
      out.push(item);
    }
    return out;
  }

  it('exposes a stable id and oauth scopes', () => {
    expect(connector.id).toBe('linear');
    expect(connector.authType).toBe('oauth');
    expect(connector.oauthScopes).toContain('read');
  });

  it('yields issues newer than the since watermark', async () => {
    fetchMock.mockResolvedValueOnce(
      graphqlResponse(issuesPayload([baseIssue], { hasNextPage: false, endCursor: null })),
    );

    const items = await collect(new Date('2026-06-01T00:00:00.000Z'));
    expect(items).toHaveLength(1);
    expect(items[0]?.externalId).toBe('issue-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The request is a POST to the GraphQL endpoint with the token verbatim.
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.linear.app/graphql');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('lin_test_token');
  });

  it('stops once an issue at/under the watermark is reached (desc order)', async () => {
    const older: LinearIssueFixture = {
      ...baseIssue,
      id: 'issue-old',
      updatedAt: '2026-05-01T00:00:00.000Z',
    };
    fetchMock.mockResolvedValueOnce(
      graphqlResponse(
        issuesPayload([baseIssue, older], { hasNextPage: true, endCursor: 'cur1' }),
      ),
    );

    const items = await collect(new Date('2026-06-10T00:00:00.000Z'));
    expect(items.map((i) => i.externalId)).toEqual(['issue-1']);
    // Crossed the watermark mid-page → no second page request.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('paginates using endCursor until hasNextPage is false', async () => {
    const second: LinearIssueFixture = {
      ...baseIssue,
      id: 'issue-2',
      identifier: 'ENG-2',
      updatedAt: '2026-06-21T09:00:00.000Z',
    };
    fetchMock
      .mockResolvedValueOnce(
        graphqlResponse(
          issuesPayload([baseIssue], { hasNextPage: true, endCursor: 'cur1' }),
        ),
      )
      .mockResolvedValueOnce(
        graphqlResponse(
          issuesPayload([second], { hasNextPage: false, endCursor: null }),
        ),
      );

    const items = await collect(new Date('2026-06-01T00:00:00.000Z'));
    expect(items.map((i) => i.externalId)).toEqual(['issue-1', 'issue-2']);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const secondInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const body = JSON.parse(secondInit.body as string) as { variables: { after: string } };
    expect(body.variables.after).toBe('cur1');
  });

  it('stops early when the rate-limit remaining is low', async () => {
    fetchMock.mockResolvedValueOnce(
      graphqlResponse(
        issuesPayload([baseIssue], { hasNextPage: true, endCursor: 'cur1' }),
        { headers: rateHeaders(2) },
      ),
    );

    const items = await collect(new Date('2026-06-01T00:00:00.000Z'));
    expect(items).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns no items on a non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce(
      graphqlResponse({ message: 'unauthorized' }, { ok: false, status: 401 }),
    );
    const items = await collect(new Date('2026-06-01T00:00:00.000Z'));
    expect(items).toHaveLength(0);
  });

  it('returns no items when GraphQL reports errors', async () => {
    fetchMock.mockResolvedValueOnce(
      graphqlResponse({ errors: [{ message: 'bad query' }] }),
    );
    const items = await collect(new Date('2026-06-01T00:00:00.000Z'));
    expect(items).toHaveLength(0);
  });

  describe('transform', () => {
    it('maps an issue to a node with state/assignee/priority/team metadata', () => {
      const { node } = connector.transform({ externalId: 'issue-1', raw: { issue: baseIssue } });
      expect(node.type).toBe('issue');
      expect(node.label).toBe('Fix the thing');
      expect(node.sourceId).toBe('linear');
      expect(node.sourceUrl).toBe('https://linear.app/acme/issue/ENG-1');
      expect(node.createdAt).toBe(baseIssue.createdAt);
      expect(node.updatedAt).toBe(baseIssue.updatedAt);
      expect(node.metadata).toMatchObject({
        identifier: 'ENG-1',
        state: 'In Progress',
        stateType: 'started',
        assignee: 'ada',
        priority: 2,
        priorityLabel: 'High',
        team: 'ENG',
        project: 'Q3 Roadmap',
      });
    });

    it('emits ASSIGNED_TO, PART_OF (project + team), and MENTIONS edges', () => {
      const { edges } = connector.transform({ externalId: 'issue-1', raw: { issue: baseIssue } });
      const relations = edges.map((e) => e.relation).sort();
      expect(relations).toEqual(['ASSIGNED_TO', 'MENTIONS', 'PART_OF', 'PART_OF']);
      expect(edges.every((e) => e.inferred === false)).toBe(true);
      expect(edges.every((e) => typeof e.id === 'string' && e.id.length > 0)).toBe(true);
    });

    it('produces deterministic node ids for idempotent re-syncs', () => {
      const a = connector.transform({ externalId: 'issue-1', raw: { issue: baseIssue } });
      const b = connector.transform({ externalId: 'issue-1', raw: { issue: baseIssue } });
      expect(a.node.id).toBe(b.node.id);
    });

    it('omits the assignee edge when there is no assignee and skips duplicate creator', () => {
      const unassigned: LinearIssueFixture = {
        ...baseIssue,
        assignee: undefined,
        creator: { id: 'user-c', displayName: 'charles' },
      };
      const { node, edges } = connector.transform({ externalId: 'issue-1', raw: { issue: unassigned } });
      const relations = edges.map((e) => e.relation).sort();
      // No ASSIGNED_TO; project + team PART_OF; MENTIONS for creator.
      expect(relations).toEqual(['MENTIONS', 'PART_OF', 'PART_OF']);
      expect(node.metadata.assignee).toBeNull();
    });

    it('does not emit a MENTIONS edge when creator equals assignee', () => {
      const selfFiled: LinearIssueFixture = {
        ...baseIssue,
        creator: { id: 'user-a', displayName: 'ada' },
      };
      const { edges } = connector.transform({ externalId: 'issue-1', raw: { issue: selfFiled } });
      expect(edges.some((e) => e.relation === 'MENTIONS')).toBe(false);
    });

    it('falls back to identifier then id for the label', () => {
      const noTitle: LinearIssueFixture = { ...baseIssue, title: undefined };
      const { node } = connector.transform({ externalId: 'issue-1', raw: { issue: noTitle } });
      expect(node.label).toBe('ENG-1');
    });
  });
});
