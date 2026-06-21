// Linear connector — ingests the user's recently updated Linear issues via the
// Linear GraphQL API. Each issue becomes one KGNode (`type: 'issue'`, label =
// title) plus a small bundle of edges:
//   - ASSIGNED_TO → the assignee (person node)
//   - PART_OF     → the issue's project and/or team
//   - MENTIONS    → the issue's creator (person node)
//
// Incremental sync (Rule 12): we page Linear's `issues` connection ordered by
// `updatedAt` descending and stop once we cross the `since` watermark. Node ids
// are derived deterministically from the upstream id via `deterministicUuid`,
// so re-syncs MERGE rather than insert.
//
// Rate limit (Rule 13): Linear returns `x-ratelimit-requests-remaining` /
// `x-ratelimit-requests-reset` headers. authedFetch surfaces the standard
// `x-ratelimit-*` snapshot; Linear's complexity-based limits are roomy enough
// for the small page budget below, and we additionally honour any explicit
// remaining-count by stopping early.
//
// Docs: https://developers.linear.app/docs/graphql/working-with-the-graphql-api

import { Injectable, Logger } from '@nestjs/common';
import type { ConnectorConfig, KGEdge, KGNode } from '@pkg/shared';
import { BaseConnector, type RawItem, type TransformResult } from './base.connector';
import {
  deterministicUuid,
  isoNow,
  newEdgeId,
  readRateLimit,
} from './connector-utils';
import { OAuthService } from '../oauth/oauth.service';

interface LinearUser {
  id: string;
  name?: string | null;
  displayName?: string | null;
  email?: string | null;
}

interface LinearRef {
  id: string;
  name?: string | null;
  key?: string | null;
}

interface LinearIssue {
  id: string;
  identifier?: string | null;
  title?: string | null;
  url?: string | null;
  priority?: number | null;
  priorityLabel?: string | null;
  createdAt: string;
  updatedAt: string;
  state?: { id: string; name?: string | null; type?: string | null } | null;
  assignee?: LinearUser | null;
  creator?: LinearUser | null;
  team?: LinearRef | null;
  project?: LinearRef | null;
}

interface IssuesPage {
  data?: {
    issues?: {
      nodes?: LinearIssue[];
      pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
    };
  };
  errors?: Array<{ message?: string }>;
}

const ENDPOINT = 'https://api.linear.app/graphql';
const PAGE_SIZE = 50;
const MAX_PAGES = 4; // 200 issues per sync — keeps the GraphQL complexity polite.

const ISSUES_QUERY = `
query Issues($first: Int!, $after: String) {
  issues(
    first: $first
    after: $after
    orderBy: updatedAt
  ) {
    nodes {
      id
      identifier
      title
      url
      priority
      priorityLabel
      createdAt
      updatedAt
      state { id name type }
      assignee { id name displayName email }
      creator { id name displayName email }
      team { id name key }
      project { id name }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

@Injectable()
export class LinearConnector extends BaseConnector {
  private readonly log = new Logger(LinearConnector.name);
  readonly id = 'linear' as const;
  readonly oauthScopes = ['read'] as const;

  constructor(private readonly oauth: OAuthService) {
    super();
  }

  async *fetchIncremental(
    config: ConnectorConfig,
    since: Date,
  ): AsyncGenerator<RawItem> {
    const creds = this.oauth.decryptCredentials(config);
    const sinceMs = since.getTime();
    let cursor: string | undefined;

    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          // Linear accepts the OAuth access token as a bare Authorization
          // header (no "Bearer " prefix) as well as personal API keys.
          authorization: creds.accessToken,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          query: ISSUES_QUERY,
          variables: { first: PAGE_SIZE, after: cursor ?? null },
        }),
      });

      // Linear names its headers `x-ratelimit-requests-remaining` /
      // `-reset` rather than the GitHub-style `x-ratelimit-remaining` that the
      // shared readRateLimit() looks for, so read it directly here (falling
      // back to the shared snapshot if the provider ever standardises).
      const remaining = parseRemaining(res);
      const rate = remaining !== undefined ? { remaining } : readRateLimit(res);

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        this.log.warn(`linear graphql ${res.status}: ${text.slice(0, 160)}`);
        return;
      }

      const json = (await res.json()) as IssuesPage;
      if (json.errors?.length) {
        const msg = json.errors.map((e) => e.message ?? '').join('; ');
        this.log.warn(`linear graphql errors: ${msg.slice(0, 160)}`);
        return;
      }

      const conn = json.data?.issues;
      const nodes = conn?.nodes ?? [];
      if (nodes.length === 0) return;

      let crossedSince = false;
      for (const issue of nodes) {
        // orderBy: updatedAt is descending, so once we hit an issue at/under
        // the watermark everything after it is older too — stop the sync.
        if (Date.parse(issue.updatedAt) <= sinceMs) {
          crossedSince = true;
          break;
        }
        yield { externalId: issue.id, raw: { issue, observedAt: isoNow() } };
      }
      if (crossedSince) return;

      if (rate.remaining !== undefined && rate.remaining < 5) {
        this.log.warn(`linear rate-limit low (${rate.remaining}); stopping`);
        return;
      }

      const info = conn?.pageInfo;
      if (!info?.hasNextPage || !info.endCursor) return;
      cursor = info.endCursor;
      this.log.debug(`linear page=${page} issues=${nodes.length}`);
    }
  }

  transform(raw: RawItem): TransformResult {
    const issue = (raw.raw as { issue: LinearIssue }).issue;
    const label = (issue.title ?? issue.identifier ?? issue.id).slice(0, 200);

    const node: KGNode = {
      id: deterministicUuid('linear', issue.id),
      type: 'issue',
      label,
      sourceId: 'linear',
      ...(issue.url ? { sourceUrl: issue.url } : {}),
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      metadata: {
        identifier: issue.identifier ?? null,
        state: issue.state?.name ?? null,
        stateType: issue.state?.type ?? null,
        assignee:
          issue.assignee?.displayName ?? issue.assignee?.name ?? null,
        priority: issue.priority ?? null,
        priorityLabel: issue.priorityLabel ?? null,
        team: issue.team?.key ?? issue.team?.name ?? null,
        project: issue.project?.name ?? null,
      },
    };

    const edges: KGEdge[] = [];

    if (issue.assignee?.id) {
      edges.push(
        edgeBetween(
          node.id,
          personId(issue.assignee.id),
          'ASSIGNED_TO',
          0.7,
        ),
      );
    }

    if (issue.project?.id) {
      edges.push(
        edgeBetween(
          node.id,
          deterministicUuid('linear', `project:${issue.project.id}`),
          'PART_OF',
          0.6,
        ),
      );
    }

    if (issue.team?.id) {
      edges.push(
        edgeBetween(
          node.id,
          deterministicUuid('linear', `team:${issue.team.id}`),
          'PART_OF',
          0.5,
        ),
      );
    }

    // Creator (if distinct from assignee) shows up as a MENTIONS edge so the
    // graph captures who filed the issue without overloading ASSIGNED_TO.
    if (issue.creator?.id && issue.creator.id !== issue.assignee?.id) {
      edges.push(
        edgeBetween(
          node.id,
          personId(issue.creator.id),
          'MENTIONS',
          0.4,
        ),
      );
    }

    return { node, edges };
  }
}

function parseRemaining(res: Response): number | undefined {
  const raw = res.headers.get('x-ratelimit-requests-remaining');
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function personId(linearUserId: string): string {
  return deterministicUuid('linear', `user:${linearUserId}`);
}

function edgeBetween(
  source: string,
  target: string,
  relation: KGEdge['relation'],
  weight: number,
): KGEdge {
  return {
    id: newEdgeId(),
    source,
    target,
    relation,
    weight,
    inferred: false,
    createdAt: isoNow(),
    metadata: {},
  };
}
