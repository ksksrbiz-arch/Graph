// Auto-update driver. Watches ConnectorConfigStore and re-enqueues a sync job
// every `syncIntervalMinutes` for each enabled connector. New configs (added
// via OAuth completion) start syncing without an API restart — the
// scheduler subscribes to the store's upsert events.
//
// Transport (ADR-005): scheduling rides on BullMQ repeatable jobs ("job
// schedulers") backed by the shared Redis instance, so multiple API instances
// coordinate through Redis instead of each running their own in-process timers.
// One queue per connector (`sync:<connectorId>`) keeps backpressure isolated.
// A single Worker per connector drains the queue and hands each fired job to
// the SyncOrchestrator, whose `enqueue`/dedupe contract is unchanged.
//
// Redis-unavailable fallback: mirroring BrainRuntimeService, if Redis cannot be
// reached we degrade to in-process `setInterval` timers (single-instance) rather
// than refusing to schedule. The trigger surface (`scheduleConfig`) is identical
// in both modes.

import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';
import type Redis from 'ioredis';
import type { ConnectorConfig, ConnectorId } from '@pkg/shared';
import { loadEnv } from '../config/env';
import { REDIS_CLIENT } from '../shared/redis/redis.module';
import { ConnectorConfigStore } from '../connectors/connector-config.store';
import { SyncOrchestrator } from './sync.orchestrator';
import type { SyncJobSpec } from './sync.types';

/** Payload carried by every scheduled BullMQ job. */
interface SyncJobData {
  userId: string;
  connectorId: ConnectorId;
}

/** In-process fallback timer (Redis unavailable). */
interface ScheduledTimer {
  intervalMs: number;
  timer: NodeJS.Timeout;
}

/** Tracks the interval a BullMQ scheduler was registered with so we can skip
 *  redundant `upsertJobScheduler` round-trips when nothing changed. */
interface ScheduledBull {
  intervalMs: number;
}

const QUEUE_PREFIX = 'sync';
const MIN_INTERVAL_MS = 60_000;

@Injectable()
export class SyncScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(SyncScheduler.name);
  /** Per-connector BullMQ queue (lazily created). */
  private readonly queues = new Map<ConnectorId, Queue<SyncJobData>>();
  /** Per-connector BullMQ worker (lazily created). */
  private readonly workers = new Map<ConnectorId, Worker<SyncJobData>>();
  /** BullMQ schedulers keyed by `${userId}|${connectorId}`. */
  private readonly scheduled = new Map<string, ScheduledBull>();
  /** Fallback timers keyed by `${userId}|${connectorId}` (Redis down). */
  private readonly timers = new Map<string, ScheduledTimer>();
  private unsubscribe?: () => void;
  /** Resolved once during init: are we driving BullMQ or in-process timers? */
  private useBull = false;

  constructor(
    private readonly configs: ConnectorConfigStore,
    private readonly orchestrator: SyncOrchestrator,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async onModuleInit(): Promise<void> {
    this.useBull = await this.probeRedis();
    if (!this.useBull) {
      this.log.warn(
        'redis unavailable — falling back to in-process setInterval scheduling (single-instance only)',
      );
    }
    this.unsubscribe = this.configs.subscribe((c) => {
      void this.scheduleConfig(c);
    });
    for (const c of this.configs.all()) await this.scheduleConfig(c);
  }

  async onModuleDestroy(): Promise<void> {
    this.unsubscribe?.();
    for (const t of this.timers.values()) clearInterval(t.timer);
    this.timers.clear();
    this.scheduled.clear();
    await Promise.all([...this.workers.values()].map((w) => w.close()));
    await Promise.all([...this.queues.values()].map((q) => q.close()));
    this.workers.clear();
    this.queues.clear();
  }

  /**
   * Idempotent: re-scheduling the same (user, connector) replaces the previous
   * schedule. Disabling a connector tears its schedule down. Drives BullMQ job
   * schedulers when Redis is available, in-process timers otherwise.
   */
  async scheduleConfig(config: ConnectorConfig): Promise<void> {
    const key = keyFor(config.userId, config.id);

    if (!config.enabled) {
      await this.unschedule(config.userId, config.id);
      return;
    }

    const intervalMs = Math.max(
      MIN_INTERVAL_MS,
      config.syncIntervalMinutes * 60_000,
    );

    if (this.useBull) {
      await this.scheduleBull(config, key, intervalMs);
    } else {
      this.scheduleTimer(config, key, intervalMs);
    }
  }

  /** Tear down both a BullMQ scheduler and any fallback timer for a pair. */
  private async unschedule(
    userId: string,
    connectorId: ConnectorId,
  ): Promise<void> {
    const key = keyFor(userId, connectorId);

    const timer = this.timers.get(key);
    if (timer) {
      clearInterval(timer.timer);
      this.timers.delete(key);
    }

    const hadBull = this.scheduled.delete(key);
    if (hadBull) {
      try {
        const queue = this.queues.get(connectorId);
        await queue?.removeJobScheduler(key);
      } catch (e) {
        this.log.warn(
          `failed to remove job scheduler ${key}: ${(e as Error).message}`,
        );
      }
    }

    if (timer || hadBull) {
      this.log.log(
        `unscheduled user=${userId} connector=${connectorId} (disabled)`,
      );
    }
  }

  // ── BullMQ path ──

  private async scheduleBull(
    config: ConnectorConfig,
    key: string,
    intervalMs: number,
  ): Promise<void> {
    const existing = this.scheduled.get(key);
    const isNew = !existing;

    if (existing && existing.intervalMs === intervalMs) return;

    try {
      const queue = this.ensureQueue(config.id);
      this.ensureWorker(config.id);
      // upsertJobScheduler is idempotent on jobSchedulerId — re-registering with
      // a new `every` replaces the prior cadence. Coordinated through Redis, so
      // every API instance registering the same id converges to one schedule.
      await queue.upsertJobScheduler(
        key,
        { every: intervalMs },
        {
          name: 'sync',
          data: { userId: config.userId, connectorId: config.id },
        },
      );
      // Kick off an immediate sync the first time this connector is seen — gives
      // the user instant feedback after completing OAuth instead of waiting for
      // the first interval. It must be a queued job (not a local enqueue): with
      // multiple API instances each booting an empty `scheduled` map, a local
      // kick would fire N times. A one-off job with a deterministic jobId
      // collapses concurrent/cross-instance adds to a single processed sync.
      if (isNew) {
        await queue.add(
          'sync',
          { userId: config.userId, connectorId: config.id },
          { jobId: `kick:${key}`, removeOnComplete: true, removeOnFail: true },
        );
      }
      this.scheduled.set(key, { intervalMs });
      this.log.log(
        `scheduled user=${config.userId} connector=${config.id} every=${config.syncIntervalMinutes}m (bullmq)`,
      );
    } catch (e) {
      this.log.error(
        `failed to schedule ${key} via bullmq: ${(e as Error).message}`,
      );
    }
  }

  private ensureQueue(connectorId: ConnectorId): Queue<SyncJobData> {
    const existing = this.queues.get(connectorId);
    if (existing) return existing;
    const queue = new Queue<SyncJobData>(queueName(connectorId), {
      connection: this.bullConnection(),
    });
    queue.on('error', (e) =>
      this.log.warn(`sync queue ${connectorId} error: ${e.message}`),
    );
    this.queues.set(connectorId, queue);
    return queue;
  }

  private ensureWorker(connectorId: ConnectorId): Worker<SyncJobData> {
    const existing = this.workers.get(connectorId);
    if (existing) return existing;
    const worker = new Worker<SyncJobData>(
      queueName(connectorId),
      (job: Job<SyncJobData>) => this.processJob(job),
      { connection: this.bullConnection() },
    );
    worker.on('error', (e) =>
      this.log.warn(`sync worker ${connectorId} error: ${e.message}`),
    );
    worker.on('failed', (job, e) =>
      this.log.warn(
        `sync job ${job?.id ?? '?'} failed on ${connectorId}: ${e.message}`,
      ),
    );
    this.workers.set(connectorId, worker);
    return worker;
  }

  /** Worker processor: a fired scheduled job re-reads the current config and
   *  hands the sync to the orchestrator (whose dedupe still applies). */
  private async processJob(job: Job<SyncJobData>): Promise<void> {
    const { userId, connectorId } = job.data;
    this.enqueueNow(userId, connectorId);
  }

  // ── in-process fallback path ──

  private scheduleTimer(
    config: ConnectorConfig,
    key: string,
    intervalMs: number,
  ): void {
    const existing = this.timers.get(key);
    if (existing && existing.intervalMs === intervalMs) return;
    if (existing) clearInterval(existing.timer);

    const timer = setInterval(() => {
      this.enqueueNow(config.userId, config.id);
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();

    this.timers.set(key, { intervalMs, timer });
    this.log.log(
      `scheduled user=${config.userId} connector=${config.id} every=${config.syncIntervalMinutes}m (timer)`,
    );

    if (!existing) this.enqueueNow(config.userId, config.id);
  }

  // ── shared ──

  /** Re-read the config (it may have changed/been disabled since scheduling)
   *  and enqueue through the orchestrator, preserving the original contract. */
  private enqueueNow(userId: string, connectorId: ConnectorId): void {
    const current = this.configs.find(userId, connectorId);
    if (!current?.enabled) return;
    const spec: SyncJobSpec = { userId, connectorId };
    this.orchestrator.enqueue(spec);
  }

  private async probeRedis(): Promise<boolean> {
    try {
      await this.redis.ping();
      return true;
    } catch (e) {
      this.log.warn(`redis ping failed: ${(e as Error).message}`);
      return false;
    }
  }

  /** BullMQ requires `maxRetriesPerRequest: null` on its connection, so it gets
   *  its own connection (built from the same URL) rather than reusing the shared
   *  REDIS_CLIENT, which is configured for fail-fast app queries. */
  private bullConnection(): ConnectionOptions {
    return { url: loadEnv().REDIS_URL, maxRetriesPerRequest: null };
  }
}

function keyFor(userId: string, connectorId: ConnectorId): string {
  return `${userId}|${connectorId}`;
}

function queueName(connectorId: ConnectorId): string {
  return `${QUEUE_PREFIX}:${connectorId}`;
}
