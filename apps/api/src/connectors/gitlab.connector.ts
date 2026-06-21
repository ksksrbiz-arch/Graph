// GitLab connector — fetches the authenticated user's recent push, issue, and
// merge-request activity across every project they have access to. Each
// upstream event becomes one KGNode plus a small bundle of edges
// (AUTHORED_BY, COMMITS_TO, PART_OF, …).
//
// Mirrors github.connector.ts: GitLab is the closest analogue. The main shape
// differences are:
//   - Auth uses a Bearer token (GitLab personal/OAuth tokens), not `token`.
//   - The events feed (/api/v4/events) is flat: `action_name`, `target_type`,
//     `target_iid`, `push_data`, `project_id` rather than nested payloads.
//   - Events carry only `project_id`, so we resolve the project's
//     `path_with_namespace` once per project and embed it in the raw payload so
//     `transform` stays a pure function.
//
// Incremental cursor (Rule 12): the events feed accepts an `after` date filter
// (day granularity); we additionally trim to the exact `since` instant in the
// loop, and node ids are derived deterministically from the upstream id via
// `deterministicUuid`, so re-syncs MERGE rather than insert.
//
// Rate limit (Rule 13): GitLab returns `ratelimit-remaining` / `ratelimit-reset`
// headers; authedFetch() surfaces whatever readRateLimit can parse and the sync
// orchestrator stashes the snapshot on the ConnectorConfig so subsequent jobs
// back off.

import { Injectable, Logger } from '@nestjs/common';
import type {
  ConnectorConfig,
  EdgeRelation,
  KGEdge,
  KGNode,
} from '@pkg/shared';
import { BaseConnector, type RawItem, type TransformResult } from './base.connector';
import {
  authedFetch,
  deterministicUuid,
  isoNow,
  newEdgeId,
} from './connector-utils';
import { OAuthService } from '../oauth/oauth.service';

const API_BASE = 'https://gitlab.com/api/v4';
const PAGE_SIZE = 50;
const MAX_PAGES = 4; // 200 events per sync — keeps us polite.

interface GitLabUser {
  id: number;
  username: string;
  name?: string;
  web_url?: string;
}

interface GitLabPushData {
  commit_count?: number;
  action?: string;
  ref_type?: string;
  commit_from?: string | null;
  commit_to?: string | null;
  ref?: string | null;
  commit_title?: string | null;
}

interface GitLabEvent {
  id: number;
  project_id: number;
  action_name: string;
  target_id?: number | null;
  target_iid?: number | null;
  target_type?: string | null;
  target_title?: string | null;
  created_at: string;
  author?: GitLabUser;
  author_username?: string;
  push_data?: GitLabPushData;
}

interface GitLabProject {
  id: number;
  path_with_namespace: string;
  web_url?: string;
}

interface RawWrapper {
  event: GitLabEvent;
  project: { id: number; path: string; webUrl?: string };
  actor: string;
}

@Injectable()
export class GitLabConnector extends BaseConnector {
  private readonly log = new Logger(GitLabConnector.name);
  readonly id = 'gitlab' as const;
  readonly oauthScopes = ['read_user', 'read_api'] as const;

  constructor(private readonly oauth: OAuthService) {
    super();
  }

  async *fetchIncremental(
    config: ConnectorConfig,
    since: Date,
  ): AsyncGenerator<RawItem> {
    const creds = this.oauth.decryptCredentials(config);
    const token = creds.accessToken;
    const sinceIso = since.toISOString();

    // The authenticated user supplies the actor login that the events feed
    // omits on some event types.
    const me = await this.fetchCurrentUser(token);

    // GitLab's `after` filter is exclusive and day-granular; subtract a day so
    // we never miss events recorded earlier on the boundary day, then trim to
    // the exact `since` instant in the loop below.
    const afterDay = new Date(since.getTime() - 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    // Resolve project paths lazily — events only carry `project_id`. Cache so a
    // burst of events on one project is a single lookup.
    const projectCache = new Map<number, GitLabProject | null>();

    for (let page = 1; page <= MAX_PAGES; page++) {
      // Pin `order_by=created_at` so the early-break cursor (which compares
      // `created_at` to `since`) doesn't depend on GitLab's default ordering.
      const url =
        `${API_BASE}/events` +
        `?per_page=${PAGE_SIZE}&page=${page}&after=${afterDay}` +
        `&order_by=created_at&sort=desc`;
      const { res, rate } = await authedFetch(url, token, {
        tokenScheme: 'bearer',
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        this.log.warn(`gitlab fetch ${res.status}: ${text.slice(0, 160)}`);
        return;
      }
      const events = (await res.json()) as GitLabEvent[];
      if (!Array.isArray(events) || events.length === 0) return;

      let crossedSince = false;
      for (const ev of events) {
        if (Date.parse(ev.created_at) <= since.getTime()) {
          crossedSince = true;
          break;
        }
        const project = await this.resolveProject(
          token,
          ev.project_id,
          projectCache,
        );
        const path = project?.path_with_namespace ?? `project-${ev.project_id}`;
        const actor = ev.author?.username ?? ev.author_username ?? me.username;
        const wrapper: RawWrapper = {
          event: ev,
          project: {
            id: ev.project_id,
            path,
            ...(project?.web_url ? { webUrl: project.web_url } : {}),
          },
          actor,
        };
        yield {
          externalId: `${ev.action_name}:${ev.id}`,
          raw: { ...wrapper, observedAt: isoNow(), rate },
        };
      }
      if (crossedSince) return;
      // GitLab emits `RateLimit-Remaining` (no `x-` prefix), which the shared
      // readRateLimit() (github-style `x-ratelimit-*`) does not parse — fall
      // back to the native header so Rule 13 back-off actually fires.
      const remaining =
        rate.remaining ?? readGitLabRemaining(res);
      if (remaining !== undefined && remaining < 5) {
        this.log.warn(`gitlab rate-limit low (${remaining}); stopping`);
        return;
      }
      this.log.debug(
        `gitlab page=${page} events=${events.length} since=${sinceIso}`,
      );
    }
  }

  transform(raw: RawItem): TransformResult {
    const wrapper = raw.raw as RawWrapper;
    const ev = wrapper.event;
    const repoPath = wrapper.project.path;
    const projectWebUrl =
      wrapper.project.webUrl ?? `https://gitlab.com/${repoPath}`;
    const author = wrapper.actor;

    // Author + project nodes are referenced by every sub-event; minting them
    // with deterministic ids means MERGE coalesces them across pushes, issue
    // events, etc.
    const authorId = deterministicUuid('gitlab', `user:${author}`);
    const repoId = deterministicUuid('gitlab', `project:${repoPath}`);
    const action = ev.action_name?.toLowerCase() ?? '';
    const targetType = ev.target_type?.toLowerCase() ?? '';

    // Push events — represent the head commit.
    if (ev.push_data || action.includes('pushed')) {
      const push = ev.push_data;
      const sha = push?.commit_to ?? `event-${ev.id}`;
      // `||` (not `??`): an empty/whitespace commit_title must fall back to a
      // non-empty label — KGNodeSchema requires label.min(1).
      const title =
        push?.commit_title?.split('\n')[0]?.trim().slice(0, 200) ||
        `push to ${push?.ref ?? repoPath}`;
      const node: KGNode = {
        id: deterministicUuid('gitlab', `commit:${repoPath}:${sha}`),
        type: 'commit',
        label: title,
        sourceId: 'gitlab',
        sourceUrl: `${projectWebUrl}/-/commit/${sha}`,
        createdAt: ev.created_at,
        updatedAt: isoNow(),
        metadata: {
          project: repoPath,
          sha,
          author,
          ref: push?.ref ?? null,
          commitCount: push?.commit_count ?? null,
          actionName: ev.action_name,
        },
      };
      return {
        node,
        edges: [
          edgeBetween(node.id, authorId, 'AUTHORED_BY', 0.7),
          edgeBetween(node.id, repoId, 'COMMITS_TO', 0.6),
        ],
      };
    }

    // Issue events.
    if (targetType === 'issue') {
      const iid = ev.target_iid ?? ev.target_id ?? 0;
      const node: KGNode = {
        id: deterministicUuid('gitlab', `issue:${repoPath}:${iid}`),
        type: 'issue',
        // `||` not `??`: empty target_title must fall back (label.min(1)).
        label: ev.target_title || `issue #${iid}`,
        sourceId: 'gitlab',
        sourceUrl: `${projectWebUrl}/-/issues/${iid}`,
        createdAt: ev.created_at,
        updatedAt: isoNow(),
        metadata: {
          project: repoPath,
          iid,
          actionName: ev.action_name,
        },
      };
      const edges = [
        edgeBetween(node.id, authorId, 'AUTHORED_BY', 0.6),
        edgeBetween(node.id, repoId, 'PART_OF', 0.5),
      ];
      // "closed" actions get an explicit CLOSES edge back to the project so the
      // reasoning layer can trace resolution activity.
      if (action.includes('closed')) {
        edges.push(edgeBetween(node.id, repoId, 'CLOSES', 0.4));
      }
      return { node, edges };
    }

    // Merge-request events → pull_request nodes. GitLab sends
    // `target_type: 'MergeRequest'`, which lowercases to 'mergerequest'.
    if (targetType === 'mergerequest') {
      const iid = ev.target_iid ?? ev.target_id ?? 0;
      const node: KGNode = {
        id: deterministicUuid('gitlab', `mr:${repoPath}:${iid}`),
        type: 'pull_request',
        // `||` not `??`: empty target_title must fall back (label.min(1)).
        label: ev.target_title || `merge request !${iid}`,
        sourceId: 'gitlab',
        sourceUrl: `${projectWebUrl}/-/merge_requests/${iid}`,
        createdAt: ev.created_at,
        updatedAt: isoNow(),
        metadata: {
          project: repoPath,
          iid,
          actionName: ev.action_name,
        },
      };
      const edges = [
        edgeBetween(node.id, authorId, 'AUTHORED_BY', 0.65),
        edgeBetween(node.id, repoId, 'PART_OF', 0.5),
      ];
      if (action.includes('merged') || action.includes('closed')) {
        edges.push(edgeBetween(node.id, repoId, 'REFERENCES', 0.4));
      }
      return { node, edges };
    }

    // Fallback: represent unknown event types as a generic project touch.
    const node: KGNode = {
      id: deterministicUuid('gitlab', `event:${ev.id}`),
      type: 'repository',
      label: `${ev.action_name} on ${repoPath}`,
      sourceId: 'gitlab',
      sourceUrl: projectWebUrl,
      createdAt: ev.created_at,
      updatedAt: isoNow(),
      metadata: {
        project: repoPath,
        actionName: ev.action_name,
        targetType: ev.target_type ?? null,
      },
    };
    return {
      node,
      edges: [edgeBetween(node.id, repoId, 'RELATED_TO', 0.3)],
    };
  }

  private async fetchCurrentUser(token: string): Promise<GitLabUser> {
    const { res } = await authedFetch(`${API_BASE}/user`, token, {
      tokenScheme: 'bearer',
    });
    if (!res.ok) {
      throw new Error(`gitlab /user failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as GitLabUser;
    if (!body.username) throw new Error('gitlab /user response missing username');
    return body;
  }

  private async resolveProject(
    token: string,
    projectId: number,
    cache: Map<number, GitLabProject | null>,
  ): Promise<GitLabProject | null> {
    if (cache.has(projectId)) return cache.get(projectId) ?? null;
    const { res } = await authedFetch(
      `${API_BASE}/projects/${projectId}`,
      token,
      { tokenScheme: 'bearer' },
    );
    if (!res.ok) {
      this.log.warn(`gitlab project ${projectId} lookup failed: ${res.status}`);
      cache.set(projectId, null);
      return null;
    }
    const project = (await res.json()) as GitLabProject;
    cache.set(projectId, project);
    return project;
  }
}

/** GitLab's native rate-limit header is `RateLimit-Remaining` (no `x-`
 *  prefix), which the shared readRateLimit() doesn't read. */
function readGitLabRemaining(res: Response): number | undefined {
  const raw = res.headers.get('ratelimit-remaining');
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function edgeBetween(
  source: string,
  target: string,
  relation: EdgeRelation,
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
