// In-process sync orchestrator. Resolves a connector by id, runs
// fetchIncremental → transform → upsert + perceive, and reports progress
// over the /sync WebSocket namespace. ADR-005 commits to BullMQ for
// production; the public method shape (`enqueue` / `runNow`) is identical to
// the eventual BullMQ Queue, so the swap is a one-file change.
//
// Concurrency: at most one sync per (userId, connectorId) at a time. A second
// `enqueue` while one is already in flight is coalesced — we log it but skip.

import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  KGEdgeSchema,
  KGNodeSchema,
  type ConnectorId,
  type SyncProgressEvent,
} from '@pkg/shared';
import { ConnectorConfigStore } from '../connectors/connector-config.store';
import { ConnectorRegistry } from '../connectors/connector-registry';
import { GraphService } from '../graph/graph.service';
import { SensoryService } from '../brain/sensory.service';
import { SyncGateway } from './sync.gateway';
import type { SyncJobResult, SyncJobSpec } from './sync.types';

const RawItemBundleSchema = z.object({
  node: KGNodeSchema,
  edges: z.array(KGEdgeSchema),
});

@Injectable()
export class SyncOrchestrator {
  private readonly log = new Logger(SyncOrchestrator.name);
  /** Active jobs keyed by `${userId}|${connectorId}` so we can dedupe. */
  private readonly active = new Set<string>();
  private readonly resultListeners = new Set<(r: SyncJobResult) => void>();

  constructor(
    private readonly registry: ConnectorRegistry,
    private readonly configs: ConnectorConfigStore,
    private readonly graph: GraphService,
    @Inject(forwardRef(() => SensoryService))
    private readonly sensory: SensoryService,
    private readonly gateway: SyncGateway,
  ) {}

  /**
   * Schedule a sync to run as soon as the event loop is free. Returns the
   * jobId synchronously so the controller can respond `202 Accepted` while
   * the work continues in the background.
   */
  enqueue(spec: SyncJobSpec): string {
    const jobId = spec.jobId ?? randomUUID();
    const key = `${spec.userId}|${spec.connectorId}`;
    if (this.active.has(key)) {
      this.log.warn(
        `coalescing duplicate sync user=${spec.userId} connector=${spec.connectorId}`,
      );
      return jobId;
    }
    this.active.add(key);
    setImmediate(() => {
      this.runJob({ ...spec, jobId })
        .catch((e) => this.log.error(`sync crashed: ${(e as Error).message}`))
        .finally(() => this.active.delete(key));
    });
    return jobId;
  }

  /** Fire-and-await variant — used by tests and shutdown drains. */
  async runNow(spec: SyncJobSpec): Promise<SyncJobResult> {
    const jobId = spec.jobId ?? randomUUID();
    const key = `${spec.userId}|${spec.connectorId}`;
    this.active.add(key);
    try {
      return await this.runJob({ ...spec, jobId });
    } finally {
      this.active.delete(key);
    }
  }

  /** Subscribe to job completion events — InsightService uses this to bump
   *  its connectome-growth timeseries when a sync lands new nodes. */
  onResult(fn: (r: SyncJobResult) => void): () => void {
    this.resultListeners.add(fn);
    return () => this.resultListeners.delete(fn);
  }

  // ── internals ──

  private async runJob(spec: Required<Pick<SyncJobSpec, 'jobId'>> & SyncJobSpec): Promise<SyncJobResult> {
    const startedAt = new Date().toISOString();
    const config = this.configs.find(spec.userId, spec.connectorId);
    if (!config) {
      return this.fail(spec, ['connector is not configured'], startedAt);
    }
    if (!config.enabled) {
      return this.fail(spec, ['connector is disabled'], startedAt);
    }
    if (!this.registry.has(spec.connectorId)) {
      return this.fail(
        spec,
        [`no connector implementation for ${spec.connectorId}`],
        startedAt,
      );
    }
    if (this.isRateLimited(config.rateLimitResetsAt)) {
      return this.fail(
        spec,
        [`rate-limited until ${config.rateLimitResetsAt}`],
        startedAt,
      );
    }

    const connector = this.registry.get(spec.connectorId);
    const since =
      spec.since ??
      (config.lastSyncAt ? new Date(config.lastSyncAt) : new Date(0));

    let processed = 0;
    let total = 0;
    const errors: string[] = [];

    try {
      for await (const raw of connector.fetchIncremental(config, since)) {
        total += 1;
        try {
          const result = connector.transform(raw);
          const bundle = RawItemBundleSchema.parse(result);
          await this.graph.upsertNode(spec.userId, bundle.node);
          for (const edge of bundle.edges) {
            await this.graph.upsertEdge(spec.userId, edge);
          }
          // Perceive fires the brain's sensory layer — every new ingest pulse
          // strengthens the relevant cortical region in real time.
          this.sensory.perceive(spec.userId, {
            id: bundle.node.id,
            type: bundle.node.type,
            sourceId: bundle.node.sourceId,
          });
          processed += 1;
        } catch (e) {
          errors.push(`item ${raw.externalId}: ${(e as Error).message}`);
        }
        this.emitProgress(spec, processed, total, errors);
      }

      const status = errors.length === 0 ? 'success' : 'partial';
      const finishedAt = new Date().toISOString();
      this.configs.recordSync(spec.userId, spec.connectorId, {
        lastSyncAt: finishedAt,
        lastSyncStatus: status,
      });
      const result: SyncJobResult = {
        jobId: spec.jobId,
        userId: spec.userId,
        connectorId: spec.connectorId,
        status,
        processed,
        total,
        errors,
        startedAt,
        finishedAt,
      };
      this.emitResult(result);
      this.log.log(
        `sync done user=${spec.userId} connector=${spec.connectorId} processed=${processed}/${total} errors=${errors.length}`,
      );
      return result;
    } catch (e) {
      errors.push((e as Error).message);
      return this.fail(spec, errors, startedAt, processed, total);
    }
  }

  private isRateLimited(resetsAt: string | undefined): boolean {
    if (!resetsAt) return false;
    return Date.parse(resetsAt) > Date.now();
  }

  private fail(
    spec: Required<Pick<SyncJobSpec, 'jobId'>> & SyncJobSpec,
    errors: string[],
    startedAt: string,
    processed = 0,
    total = 0,
  ): SyncJobResult {
    const finishedAt = new Date().toISOString();
    this.configs.recordSync(spec.userId, spec.connectorId, {
      lastSyncAt: finishedAt,
      lastSyncStatus: 'failed',
    });
    const result: SyncJobResult = {
      jobId: spec.jobId,
      userId: spec.userId,
      connectorId: spec.connectorId,
      status: 'failed',
      processed,
      total,
      errors,
      startedAt,
      finishedAt,
    };
    this.emitResult(result);
    this.log.warn(
      `sync failed user=${spec.userId} connector=${spec.connectorId}: ${errors.join('; ')}`,
    );
    return result;
  }

  private emitProgress(
    spec: { jobId: string; userId: string; connectorId: ConnectorId },
    processed: number,
    total: number,
    errors: string[],
  ): void {
    const evt: SyncProgressEvent = {
      jobId: spec.jobId,
      connectorId: spec.connectorId,
      processed,
      total,
      errors,
    };
    this.gateway.emitProgress(spec.userId, evt);
  }

  private emitResult(result: SyncJobResult): void {
    this.gateway.emitResult(result.userId, result);
    for (const fn of this.resultListeners) {
      try {
        fn(result);
      } catch (e) {
        this.log.warn(`result listener crashed: ${(e as Error).message}`);
      }
    }
  }
}
