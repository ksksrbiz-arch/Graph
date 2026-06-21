// Todoist connector — fetches the user's active tasks and projects from the
// Todoist REST API v2 and ingests them into the graph. Each task becomes a
// `task` KGNode; each project becomes a parent node, and tasks are wired to
// their project via a `PART_OF` edge (and to a sub-task parent via `PART_OF`
// as well when one exists).
//
// Authentication: Todoist uses a static API token (Bearer scheme) rather than
// a refreshing OAuth flow for personal use, so this connector is `apikey`. The
// raw token lives in ConnectorConfig.credentials as `accessToken`, mirroring
// the Zotero connector.
//
// Incremental sync (Rule 12): the REST v2 `/tasks` endpoint returns only
// active (non-completed) tasks and does not accept a server-side `since`
// filter, so we page client-side and skip items older than `since` (by
// created_at). Node ids are derived deterministically from the Todoist object
// id via `deterministicUuid`, so re-syncs MERGE rather than insert. Project
// nodes are minted with deterministic ids too, so they coalesce across every
// task that references them.
//
// Rate limits (Rule 13): Todoist returns `Retry-After` on HTTP 429.
// authedFetch surfaces that via readRateLimit so the orchestrator can back off.
//
// Docs: https://developer.todoist.com/rest/v2/

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

interface TodoistDue {
  date?: string;
  string?: string;
  datetime?: string;
  timezone?: string;
  is_recurring?: boolean;
}

interface TodoistProject {
  id: string;
  name: string;
  color?: string;
  is_favorite?: boolean;
  is_inbox_project?: boolean;
  url?: string;
  parent_id?: string | null;
}

interface TodoistTask {
  id: string;
  content: string;
  description?: string;
  project_id?: string;
  section_id?: string | null;
  parent_id?: string | null;
  priority?: number;
  is_completed?: boolean;
  labels?: string[];
  due?: TodoistDue | null;
  url?: string;
  created_at?: string;
}

/** Discriminated wrapper so transform() can tell tasks and projects apart
 *  without re-fetching. The fetch stage tags each raw item with its kind. */
type TodoistRaw =
  | { kind: 'task'; task: TodoistTask; projectName?: string }
  | { kind: 'project'; project: TodoistProject };

// The REST v2 /tasks endpoint returns the full active set in a single
// response (no server-side paging or `since` filter), so we just cap how many
// items we emit per sync to keep Phase 0 polite.
const MAX_TASKS_PER_SYNC = 200;
const REST_BASE = 'https://api.todoist.com/rest/v2';

@Injectable()
export class TodoistConnector extends BaseConnector {
  private readonly log = new Logger(TodoistConnector.name);
  readonly id = 'todoist' as const;
  readonly oauthScopes = ['data:read'] as const;
  override readonly authType = 'apikey' as const;

  constructor(private readonly oauth: OAuthService) {
    super();
  }

  async *fetchIncremental(
    config: ConnectorConfig,
    since: Date,
  ): AsyncGenerator<RawItem> {
    const creds = this.oauth.decryptCredentials(config);
    const token = creds.accessToken;

    // 1) Pull the project list first so we can both emit project nodes and
    //    label each task's parent project for the node metadata.
    const projects = await this.fetchProjects(token);
    const projectNames = new Map<string, string>();
    for (const project of projects) {
      projectNames.set(project.id, project.name);
      yield {
        externalId: `project:${project.id}`,
        raw: { kind: 'project', project } satisfies TodoistRaw,
      };
    }

    // 2) Pull active tasks. The REST v2 endpoint returns the full active set
    //    in one shot, so we emit up to MAX_TASKS_PER_SYNC of them and skip
    //    items older than the `since` watermark (by created_at).
    const tasks = await this.fetchTasks(token);
    let emitted = 0;
    for (const task of tasks) {
      if (emitted >= MAX_TASKS_PER_SYNC) {
        this.log.debug(`todoist task cap reached at ${emitted}`);
        break;
      }
      const created = task.created_at ? Date.parse(task.created_at) : NaN;
      if (Number.isFinite(created) && created <= since.getTime()) {
        // Tasks aren't guaranteed sorted by created_at, so skip stale items
        // rather than breaking outright.
        continue;
      }
      emitted += 1;
      yield {
        externalId: `task:${task.id}`,
        raw: {
          kind: 'task',
          task,
          ...(task.project_id && projectNames.has(task.project_id)
            ? { projectName: projectNames.get(task.project_id) }
            : {}),
        } satisfies TodoistRaw,
      };
    }
  }

  transform(raw: RawItem): TransformResult {
    const payload = raw.raw as TodoistRaw;
    if (payload.kind === 'project') {
      return this.transformProject(payload.project);
    }
    return this.transformTask(payload.task, payload.projectName);
  }

  private transformProject(project: TodoistProject): TransformResult {
    const nodeId = deterministicUuid('todoist', `project:${project.id}`);
    const node: KGNode = {
      id: nodeId,
      // No dedicated project NodeType exists in the shared union; `list_item`
      // is the closest "container" type. Cast is local per coordinator note.
      type: 'list_item' as KGNode['type'],
      label: project.name.slice(0, 200) || '(untitled project)',
      sourceId: 'todoist',
      ...(project.url ? { sourceUrl: project.url } : {}),
      createdAt: isoNow(),
      updatedAt: isoNow(),
      metadata: {
        todoistId: project.id,
        kind: 'project',
        color: project.color ?? null,
        isFavorite: project.is_favorite ?? false,
        isInbox: project.is_inbox_project ?? false,
      },
    };

    const edges: KGEdge[] = [];
    // Nested projects hang off their parent project via PART_OF.
    if (project.parent_id) {
      edges.push(
        edgeBetween(
          nodeId,
          deterministicUuid('todoist', `project:${project.parent_id}`),
          'PART_OF',
          0.5,
        ),
      );
    }
    return { node, edges };
  }

  private transformTask(
    task: TodoistTask,
    projectName?: string,
  ): TransformResult {
    const nodeId = deterministicUuid('todoist', `task:${task.id}`);
    const due = task.due ?? null;
    const node: KGNode = {
      id: nodeId,
      type: 'task',
      label: (task.content || '(untitled task)').slice(0, 200),
      sourceId: 'todoist',
      ...(task.url ? { sourceUrl: task.url } : {}),
      createdAt: task.created_at ?? isoNow(),
      updatedAt: isoNow(),
      metadata: {
        todoistId: task.id,
        project: projectName ?? null,
        projectId: task.project_id ?? null,
        sectionId: task.section_id ?? null,
        description: task.description?.slice(0, 500) || null,
        priority: task.priority ?? 1,
        completed: task.is_completed ?? false,
        labels: task.labels ?? [],
        due: due?.date ?? due?.datetime ?? null,
        dueString: due?.string ?? null,
        isRecurring: due?.is_recurring ?? false,
      },
    };

    const edges: KGEdge[] = [];
    // A sub-task belongs to its parent task; otherwise it belongs to its
    // project. Both use PART_OF (a valid EdgeRelation).
    if (task.parent_id) {
      edges.push(
        edgeBetween(
          nodeId,
          deterministicUuid('todoist', `task:${task.parent_id}`),
          'PART_OF',
          0.6,
        ),
      );
    }
    if (task.project_id) {
      edges.push(
        edgeBetween(
          nodeId,
          deterministicUuid('todoist', `project:${task.project_id}`),
          'PART_OF',
          0.5,
        ),
      );
    }
    return { node, edges };
  }

  private async fetchProjects(token: string): Promise<TodoistProject[]> {
    const { res } = await authedFetch(`${REST_BASE}/projects`, token);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      this.log.warn(`todoist projects ${res.status}: ${text.slice(0, 160)}`);
      return [];
    }
    const body = (await res.json()) as unknown;
    return Array.isArray(body) ? (body as TodoistProject[]) : [];
  }

  private async fetchTasks(token: string): Promise<TodoistTask[]> {
    // authedFetch already parsed any `retry-after` header into `rate.resetsAt`
    // (connector-utils readRateLimit), so we reuse that instead of re-reading.
    const { res, rate } = await authedFetch(`${REST_BASE}/tasks`, token);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      this.log.warn(`todoist tasks ${res.status}: ${text.slice(0, 160)}`);
      if (res.status === 429) {
        this.log.warn(
          `todoist rate-limited; resets at ${rate.resetsAt ?? 'unknown'}`,
        );
      }
      return [];
    }
    if (rate.remaining !== undefined && rate.remaining < 5) {
      this.log.warn(`todoist rate-limit low (${rate.remaining})`);
    }
    const body = (await res.json()) as unknown;
    return Array.isArray(body) ? (body as TodoistTask[]) : [];
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
