// GitHub connector — fetches the authenticated user's recent commits, issues,
// and pull requests across every repo they have access to. Each upstream item
// becomes one KGNode plus a small bundle of edges (AUTHORED_BY, ASSIGNED_TO,
// COMMITS_TO).
//
// Rate limit (Rule 13): GitHub returns `x-ratelimit-remaining` /
// `x-ratelimit-reset` on every response. authedFetch() in connector-utils
// surfaces those headers; the sync orchestrator stashes the snapshot on the
// ConnectorConfig so subsequent jobs back off.
//
// Idempotency (Rule 12): node ids are derived deterministically from the
// upstream id via `deterministicUuid`, so re-syncs MERGE rather than insert.

import { Injectable, Logger } from '@nestjs/common';
import type { ConnectorConfig, KGEdge, KGNode } from '@pkg/shared';
import { BaseConnector, type RawItem, type TransformResult } from './base.connector';
import {
  authedFetch,
  deterministicUuid,
  isoNow,
  newEdgeId,
} from './connector-utils';
import { OAuthService } from '../oauth/oauth.service';

interface GitHubEvent {
  id: string;
  type: string;
  created_at: string;
  repo: { id: number; name: string; url: string };
  actor: { id: number; login: string; avatar_url: string };
  payload: Record<string, unknown>;
}

const PAGE_SIZE = 50;
const MAX_PAGES = 4; // 200 events per sync — keeps Phase 0 polite.

@Injectable()
export class GitHubConnector extends BaseConnector {
  private readonly log = new Logger(GitHubConnector.name);
  readonly id = 'github' as const;
  readonly oauthScopes = ['read:user', 'repo'] as const;

  constructor(private readonly oauth: OAuthService) {
    super();
  }

  async *fetchIncremental(
    config: ConnectorConfig,
    since: Date,
  ): AsyncGenerator<RawItem> {
    const creds = this.oauth.decryptCredentials(config);
    const sinceIso = since.toISOString();

    // /users/{login}/events delivers 30-day cross-repo activity efficiently.
    // We have to look up the username first since the OAuth payload doesn't
    // carry it.
    const login = await this.fetchLogin(creds.accessToken);

    for (let page = 1; page <= MAX_PAGES; page++) {
      const url =
        `https://api.github.com/users/${encodeURIComponent(login)}/events` +
        `?per_page=${PAGE_SIZE}&page=${page}`;
      const { res, rate } = await authedFetch(url, creds.accessToken, {
        tokenScheme: 'token',
        headers: { accept: 'application/vnd.github+json' },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        this.log.warn(`github fetch ${res.status}: ${text.slice(0, 160)}`);
        return;
      }
      const events = (await res.json()) as GitHubEvent[];
      if (events.length === 0) return;

      let crossedSince = false;
      for (const ev of events) {
        if (Date.parse(ev.created_at) <= since.getTime()) {
          crossedSince = true;
          break;
        }
        yield {
          externalId: `${ev.type}:${ev.id}`,
          raw: { event: ev, login, rate, observedAt: isoNow() },
        };
      }
      if (crossedSince) return;
      if (rate.remaining !== undefined && rate.remaining < 5) {
        this.log.warn(`github rate-limit low (${rate.remaining}); stopping`);
        return;
      }
      this.log.debug(
        `github page=${page} events=${events.length} since=${sinceIso}`,
      );
    }
  }

  transform(raw: RawItem): TransformResult {
    const wrapper = raw.raw as { event: GitHubEvent; login: string };
    const ev = wrapper.event;
    const repoName = ev.repo.name;
    const author = wrapper.login;

    // Author + repo nodes are referenced by every sub-event; minting them with
    // deterministic ids means MERGE coalesces them across PushEvents,
    // IssuesEvents, etc.
    const authorId = deterministicUuid('github', `user:${author}`);
    const repoId = deterministicUuid('github', `repo:${repoName}`);

    if (ev.type === 'PushEvent') {
      const payload = ev.payload as {
        commits?: Array<{ sha: string; message: string; url: string }>;
      };
      const commit = payload.commits?.[0];
      const sha = commit?.sha ?? ev.id;
      const node: KGNode = {
        id: deterministicUuid('github', `commit:${repoName}:${sha}`),
        type: 'commit',
        label: commit?.message?.split('\n')[0]?.slice(0, 200) ?? `commit ${sha.slice(0, 7)}`,
        sourceId: 'github',
        sourceUrl: `https://github.com/${repoName}/commit/${sha}`,
        createdAt: ev.created_at,
        updatedAt: isoNow(),
        metadata: { repo: repoName, sha, author, eventType: ev.type },
      };
      return {
        node,
        edges: [
          edgeBetween(node.id, authorId, 'AUTHORED_BY', 0.7),
          edgeBetween(node.id, repoId, 'COMMITS_TO', 0.6),
        ],
      };
    }

    if (ev.type === 'IssuesEvent' || ev.type === 'IssueCommentEvent') {
      const issue = (ev.payload as { issue?: { number: number; title: string; html_url: string; user?: { login: string } } }).issue;
      const num = issue?.number ?? 0;
      const node: KGNode = {
        id: deterministicUuid('github', `issue:${repoName}:${num}`),
        type: 'issue',
        label: issue?.title ?? `issue #${num}`,
        sourceId: 'github',
        ...(issue?.html_url ? { sourceUrl: issue.html_url } : {}),
        createdAt: ev.created_at,
        updatedAt: isoNow(),
        metadata: { repo: repoName, number: num, eventType: ev.type },
      };
      return {
        node,
        edges: [
          edgeBetween(node.id, authorId, 'AUTHORED_BY', 0.6),
          edgeBetween(node.id, repoId, 'PART_OF', 0.5),
        ],
      };
    }

    if (
      ev.type === 'PullRequestEvent' ||
      ev.type === 'PullRequestReviewEvent' ||
      ev.type === 'PullRequestReviewCommentEvent'
    ) {
      const pr = (ev.payload as { pull_request?: { number: number; title: string; html_url: string } }).pull_request;
      const num = pr?.number ?? 0;
      const node: KGNode = {
        id: deterministicUuid('github', `pr:${repoName}:${num}`),
        type: 'pull_request',
        label: pr?.title ?? `PR #${num}`,
        sourceId: 'github',
        ...(pr?.html_url ? { sourceUrl: pr.html_url } : {}),
        createdAt: ev.created_at,
        updatedAt: isoNow(),
        metadata: { repo: repoName, number: num, eventType: ev.type },
      };
      return {
        node,
        edges: [
          edgeBetween(node.id, authorId, 'AUTHORED_BY', 0.65),
          edgeBetween(node.id, repoId, 'PART_OF', 0.5),
        ],
      };
    }

    // Fallback: represent unknown event types as a generic repository touch.
    const node: KGNode = {
      id: deterministicUuid('github', `event:${ev.id}`),
      type: 'repository',
      label: `${ev.type} on ${repoName}`,
      sourceId: 'github',
      createdAt: ev.created_at,
      updatedAt: isoNow(),
      metadata: { repo: repoName, eventType: ev.type },
    };
    return {
      node,
      edges: [edgeBetween(node.id, repoId, 'RELATED_TO', 0.3)],
    };
  }

  private async fetchLogin(accessToken: string): Promise<string> {
    const { res } = await authedFetch('https://api.github.com/user', accessToken, {
      tokenScheme: 'token',
      headers: { accept: 'application/vnd.github+json' },
    });
    if (!res.ok) {
      throw new Error(`github /user failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as { login?: string };
    if (!body.login) throw new Error('github /user response missing login');
    return body.login;
  }
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
