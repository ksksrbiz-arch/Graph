// Auto-update driver. Watches ConnectorConfigStore and re-enqueues a sync job
// every `syncIntervalMinutes` for each enabled connector. New configs (added
// via OAuth completion) start syncing without an API restart — the
// scheduler subscribes to the store's upsert events.
//
// Production swap (ADR-005): replace `setInterval` with BullMQ's
// `Queue.add(..., { repeat: { every } })`. The trigger surface
// (`scheduleConfig` / `unscheduleConfig`) stays identical.

import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { ConnectorConfig, ConnectorId } from '@pkg/shared';
import { ConnectorConfigStore } from '../connectors/connector-config.store';
import { SyncOrchestrator } from './sync.orchestrator';

interface ScheduledTimer {
  userId: string;
  connectorId: ConnectorId;
  intervalMs: number;
  timer: NodeJS.Timeout;
}

@Injectable()
export class SyncScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(SyncScheduler.name);
  private readonly timers = new Map<string, ScheduledTimer>();
  private unsubscribe?: () => void;

  constructor(
    private readonly configs: ConnectorConfigStore,
    private readonly orchestrator: SyncOrchestrator,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.configs.subscribe((c) => this.scheduleConfig(c));
    for (const c of this.configs.all()) this.scheduleConfig(c);
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    for (const t of this.timers.values()) clearInterval(t.timer);
    this.timers.clear();
  }

  /** Idempotent: re-scheduling the same (user, connector) clears the
   *  previous timer first. Disabling a connector tears its timer down. */
  scheduleConfig(config: ConnectorConfig): void {
    const key = keyFor(config.userId, config.id);
    const existing = this.timers.get(key);

    if (!config.enabled) {
      if (existing) {
        clearInterval(existing.timer);
        this.timers.delete(key);
        this.log.log(
          `unscheduled user=${config.userId} connector=${config.id} (disabled)`,
        );
      }
      return;
    }

    const intervalMs = Math.max(60_000, config.syncIntervalMinutes * 60_000);
    if (existing && existing.intervalMs === intervalMs) return;
    if (existing) clearInterval(existing.timer);

    const timer = setInterval(() => {
      // Re-read the config in case it changed since the timer was set.
      const current = this.configs.find(config.userId, config.id);
      if (!current?.enabled) return;
      this.orchestrator.enqueue({
        userId: config.userId,
        connectorId: config.id,
      });
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();

    this.timers.set(key, {
      userId: config.userId,
      connectorId: config.id,
      intervalMs,
      timer,
    });
    this.log.log(
      `scheduled user=${config.userId} connector=${config.id} every=${config.syncIntervalMinutes}m`,
    );

    // Kick off an immediate sync the first time we see a connector — gives the
    // user instant feedback after completing OAuth instead of waiting for the
    // first interval to fire.
    if (!existing) {
      this.orchestrator.enqueue({
        userId: config.userId,
        connectorId: config.id,
      });
    }
  }
}

function keyFor(userId: string, connectorId: ConnectorId): string {
  return `${userId}|${connectorId}`;
}
