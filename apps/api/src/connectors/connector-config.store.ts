// In-memory store of ConnectorConfig keyed by (userId, connectorId). Phase 0
// scaffold so OAuth + sync can run end-to-end without the Postgres-backed
// `connector_configs` table — Phase 1 will move this behind a Repository
// interface that wraps `pg`. Methods stay shaped like the future
// repository so the swap is mechanical.

import { Injectable } from '@nestjs/common';
import type { ConnectorConfig, ConnectorId, SyncStatus } from '@pkg/shared';

type Listener = (config: ConnectorConfig) => void;

@Injectable()
export class ConnectorConfigStore {
  private readonly byUser = new Map<string, Map<ConnectorId, ConnectorConfig>>();
  private readonly listeners = new Set<Listener>();

  upsert(config: ConnectorConfig): ConnectorConfig {
    const userMap = this.byUser.get(config.userId) ?? new Map();
    userMap.set(config.id, config);
    this.byUser.set(config.userId, userMap);
    for (const fn of this.listeners) fn(config);
    return config;
  }

  find(userId: string, connectorId: ConnectorId): ConnectorConfig | undefined {
    return this.byUser.get(userId)?.get(connectorId);
  }

  listForUser(userId: string): ConnectorConfig[] {
    return [...(this.byUser.get(userId)?.values() ?? [])];
  }

  /** Iterate every (user, connector) pair currently configured. Used by the
   *  scheduler to register repeatable sync jobs at startup. */
  *all(): Iterable<ConnectorConfig> {
    for (const userMap of this.byUser.values()) {
      for (const config of userMap.values()) yield config;
    }
  }

  setEnabled(
    userId: string,
    connectorId: ConnectorId,
    enabled: boolean,
  ): ConnectorConfig | undefined {
    const config = this.find(userId, connectorId);
    if (!config) return undefined;
    return this.upsert({ ...config, enabled });
  }

  recordSync(
    userId: string,
    connectorId: ConnectorId,
    update: {
      lastSyncAt: string;
      lastSyncStatus: SyncStatus;
      rateLimitRemaining?: number;
      rateLimitResetsAt?: string;
    },
  ): ConnectorConfig | undefined {
    const config = this.find(userId, connectorId);
    if (!config) return undefined;
    return this.upsert({
      ...config,
      lastSyncAt: update.lastSyncAt,
      lastSyncStatus: update.lastSyncStatus,
      ...(update.rateLimitRemaining !== undefined
        ? { rateLimitRemaining: update.rateLimitRemaining }
        : {}),
      ...(update.rateLimitResetsAt !== undefined
        ? { rateLimitResetsAt: update.rateLimitResetsAt }
        : {}),
    });
  }

  remove(userId: string, connectorId: ConnectorId): boolean {
    return this.byUser.get(userId)?.delete(connectorId) ?? false;
  }

  /** Subscribe to upsert events. Used by SyncScheduler so a freshly-connected
   *  connector starts auto-syncing without an API restart. */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
