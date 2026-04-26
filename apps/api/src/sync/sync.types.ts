import type { ConnectorId, SyncStatus } from '@pkg/shared';

export interface SyncJobSpec {
  userId: string;
  connectorId: ConnectorId;
  /** Optional override for the `since` cursor — defaults to lastSyncAt. */
  since?: Date;
  /** Set by the scheduler so worker logs can correlate to the job they ran. */
  jobId?: string;
}

export interface SyncJobResult {
  jobId: string;
  userId: string;
  connectorId: ConnectorId;
  status: SyncStatus;
  processed: number;
  total: number;
  errors: string[];
  startedAt: string;
  finishedAt: string;
}
