// Writes append-only records to the `audit_events` table (Rule 18, spec §10.4).
// Callers supply what they know; the interceptor fills in ip/userId from the
// request context.

import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { POSTGRES_POOL } from '../shared/postgres/postgres.module';

export interface AuditLogEntry {
  userId?: string | null;
  action: string;
  resource?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
}

@Injectable()
export class AuditService {
  private readonly log = new Logger(AuditService.name);

  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  async record(entry: AuditLogEntry): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO audit_events
           (user_id, action, resource, resource_id, metadata, ip_address)
         VALUES ($1, $2, $3, $4, $5, $6::inet)`,
        [
          entry.userId ?? null,
          entry.action,
          entry.resource ?? null,
          entry.resourceId ?? null,
          entry.metadata ? JSON.stringify(entry.metadata) : null,
          entry.ipAddress ?? null,
        ],
      );
    } catch (err) {
      // Audit failures must never crash the request — just log and move on.
      this.log.error(
        `audit write failed action=${entry.action}: ${String(err)}`,
      );
    }
  }
}
