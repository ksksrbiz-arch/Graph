// Service backing the public, anonymous ingest path. Wraps GraphRepository
// so paste-in-the-website can produce real KGNodes for the demo userId,
// pokes the brain via SensoryService.perceive(), and queues a debounced
// connectome reload so newly-added nodes start firing soon after.
//
// Intentionally narrow surface — only the demo userIds in
// PUBLIC_INGEST_USER_IDS may write through this path. Wider, multi-tenant
// ingest belongs behind the JWT-guarded sync orchestrator (Phases 1+).

import {
  ForbiddenException,
  Injectable,
  Logger,
  PayloadTooLargeException,
} from '@nestjs/common';
import type { KGEdge, KGNode } from '@pkg/shared';
import { loadEnv } from '../config/env';
import { splitCsvEnv } from '../config/env-utils';
import { BrainService } from '../brain/brain.service';
import { SensoryService } from '../brain/sensory.service';
import { GraphRepository } from '../graph/graph.repository';
import {
  parseMarkdown,
  parseText,
  type ParseResult,
} from './text-parser';

export interface PublicIngestRequest {
  userId: string;
  format: 'text' | 'markdown';
  content: string;
  title?: string;
}

export interface PublicIngestResult {
  userId: string;
  format: 'text' | 'markdown';
  parentId: string;
  nodes: number;
  edges: number;
  brainQueuedReload: boolean;
}

const RELOAD_DEBOUNCE_MS = 4_000;

@Injectable()
export class PublicIngestService {
  private readonly log = new Logger(PublicIngestService.name);
  private readonly env = loadEnv();
  private readonly allowedUserIds = new Set(splitCsvEnv(this.env.PUBLIC_INGEST_USER_IDS));
  private readonly maxBytes = this.env.PUBLIC_INGEST_MAX_BYTES;
  private readonly reloadTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly graph: GraphRepository,
    private readonly sensory: SensoryService,
    private readonly brain: BrainService,
  ) {}

  /** True when the public ingest path is configured for at least one user. */
  isEnabled(): boolean {
    return this.allowedUserIds.size > 0;
  }

  /** Allowlist + body-size gate. Throws on rejection so the controller
   *  surfaces 403 / 413 with the right message. */
  assertAllowed(userId: string, contentLength: number): void {
    if (!this.allowedUserIds.has(userId)) {
      throw new ForbiddenException(
        `userId=${userId} is not on the public ingest allowlist`,
      );
    }
    if (contentLength > this.maxBytes) {
      throw new PayloadTooLargeException(
        `payload exceeds ${this.maxBytes} bytes (got ${contentLength})`,
      );
    }
  }

  /** Parse + upsert + perceive. Returns counts so the controller can echo a
   *  receipt the SPA renders inline. */
  async ingest(req: PublicIngestRequest): Promise<PublicIngestResult> {
    this.assertAllowed(req.userId, Buffer.byteLength(req.content, 'utf8'));

    const title = (req.title || defaultTitle(req)).slice(0, 200);
    const parsed = req.format === 'markdown'
      ? parseMarkdown(req.content, { userId: req.userId, sourceId: 'obsidian', title })
      : parseText(req.content, { userId: req.userId, sourceId: 'bookmarks', title });

    await this.persist(req.userId, parsed);

    let queued = false;
    if (this.brain.isRunning(req.userId)) {
      // Existing connectome only gets stimuli for neurons it already knows
      // about — perceive() is a no-op otherwise. The debounced reload picks
      // up the freshly-upserted neurons after a short quiet period.
      for (const node of parsed.nodes) {
        this.sensory.perceive(req.userId, node);
      }
      this.scheduleReload(req.userId);
      queued = true;
    }

    this.log.log(
      `public ingest user=${req.userId} format=${req.format} +${parsed.nodes.length} nodes / ${parsed.edges.length} edges`,
    );
    return {
      userId: req.userId,
      format: req.format,
      parentId: parsed.parentId,
      nodes: parsed.nodes.length,
      edges: parsed.edges.length,
      brainQueuedReload: queued,
    };
  }

  /** Nodes + edges added since `sinceIso`. Drives the SPA's live ticker
   *  (poll loop in graph-live.js) — clients send back the `ts` we return so
   *  the next poll only fetches what's new since this one served. */
  async snapshotDelta(
    userId: string,
    sinceIso: string,
    limit = 5_000,
  ): Promise<{
    schemaVersion: number;
    metadata: { ts: string; userId: string; since: string };
    nodes: KGNode[];
    edges: KGEdge[];
  }> {
    if (!this.allowedUserIds.has(userId)) {
      throw new ForbiddenException(`userId=${userId} is not on the public allowlist`);
    }
    const ts = new Date().toISOString();
    const { nodes, edges } = await this.graph.snapshotDeltaForUser(userId, sinceIso, limit);
    return {
      schemaVersion: 1,
      metadata: { ts, userId, since: sinceIso },
      nodes,
      edges,
    };
  }

  /** Snapshot the demo user's full graph back out so the website can render
   *  it. Cursor-based pagination is overkill at this scale (Phase 0 target is
   *  a few thousand nodes); we cap with a hard limit instead. */
  async snapshot(userId: string, limit = 5_000): Promise<{
    schemaVersion: number;
    metadata: { updatedAt: string; userId: string; sources: string[] };
    nodes: KGNode[];
    edges: KGEdge[];
  }> {
    if (!this.allowedUserIds.has(userId)) {
      throw new ForbiddenException(`userId=${userId} is not on the public allowlist`);
    }
    const { nodes, edges } = await this.graph.snapshotForUser(userId, limit);
    const sources = [...new Set(nodes.map((n) => n.sourceId).filter(Boolean))];
    return {
      schemaVersion: 1,
      metadata: { updatedAt: new Date().toISOString(), userId, sources },
      nodes,
      edges,
    };
  }

  private async persist(userId: string, parsed: ParseResult): Promise<void> {
    for (const node of parsed.nodes) {
      try {
        await this.graph.upsertNode(userId, node);
      } catch (e) {
        this.log.warn(`upsertNode failed (${node.id}): ${(e as Error).message}`);
      }
    }
    for (const edge of parsed.edges) {
      try {
        await this.graph.upsertEdge(userId, edge);
      } catch (e) {
        this.log.warn(`upsertEdge failed (${edge.id}): ${(e as Error).message}`);
      }
    }
  }

  /** Debounced brain reload — coalesces rapid pastes so we don't churn the
   *  simulator. BrainService.start() is idempotent (drops existing timers and
   *  reloads the connectome), so calling it again is safe. */
  private scheduleReload(userId: string): void {
    const existing = this.reloadTimers.get(userId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.reloadTimers.delete(userId);
      this.brain.start(userId).catch((e) => {
        this.log.warn(`brain reload failed user=${userId}: ${(e as Error).message}`);
      });
    }, RELOAD_DEBOUNCE_MS);
    if (typeof timer.unref === 'function') timer.unref();
    this.reloadTimers.set(userId, timer);
  }
}

function defaultTitle(req: PublicIngestRequest): string {
  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
  return req.format === 'markdown'
    ? `Pasted markdown — ${stamp}`
    : `Pasted text — ${stamp}`;
}
