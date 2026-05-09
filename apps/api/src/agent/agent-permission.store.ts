// Per-user permission grants for the autonomous cortex agent. The agent runs
// only the tools the user has explicitly granted, and every grant is
// scope-tagged so a user can hand the agent fine-grained access:
//
//   agent:enact-motor             — execute proposed motor actions
//   agent:investigate             — fire follow-up cortex passes on weak nodes
//   agent:predict-links           — surface high-score predicted links
//   agent:ingest:<connectorId>    — trigger a sync from a specific connector
//   agent:ingest:*                — trigger any configured connector
//   agent:propose-edge            — record a proposed edge for review
//
// Storage is in-memory for now (Phase 0); the public API matches the eventual
// Postgres-backed grant table so the swap is mechanical. Default policy is
// **deny**: no tool runs unless the user has granted it.

import { BadRequestException, Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import type { Pool } from 'pg';
import { POSTGRES_POOL } from '../shared/postgres/postgres.module';

export type AgentPermissionScope =
  | 'agent:enact-motor'
  | 'agent:investigate'
  | 'agent:predict-links'
  | 'agent:propose-edge'
  | `agent:ingest:${string}`;

/** Allowed top-level scopes. Ingest scopes are namespaced, validated below. */
const FIXED_SCOPES = new Set<string>([
  'agent:enact-motor',
  'agent:investigate',
  'agent:predict-links',
  'agent:propose-edge',
]);

const INGEST_PREFIX = 'agent:ingest:';
const INGEST_TARGET_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$|^\*$/;

/** Validate that `scope` matches one of the allowed forms. Throws
 *  `BadRequestException` otherwise so the controller layer returns a 400. */
export function validateScope(scope: string): AgentPermissionScope {
  if (typeof scope !== 'string' || scope.length === 0 || scope.length > 256) {
    throw new BadRequestException(`invalid permission scope: must be a non-empty string`);
  }
  if (FIXED_SCOPES.has(scope)) return scope as AgentPermissionScope;
  if (scope.startsWith(INGEST_PREFIX)) {
    const target = scope.slice(INGEST_PREFIX.length);
    if (!INGEST_TARGET_PATTERN.test(target)) {
      throw new BadRequestException(
        `invalid ingest scope: target must match /[a-z0-9][a-z0-9_-]{0,63}/ or be '*'`,
      );
    }
    return scope as AgentPermissionScope;
  }
  throw new BadRequestException(
    `unknown permission scope: ${scope}. Allowed: ${[...FIXED_SCOPES].join(', ')}, agent:ingest:<connectorId|*>`,
  );
}

export interface AgentPermissionGrant {
  userId: string;
  scope: AgentPermissionScope;
  /** ISO-8601 — null = no expiry. */
  expiresAt: string | null;
  /** Wall-clock ISO timestamp when this grant was created. */
  grantedAt: string;
}

@Injectable()
export class AgentPermissionStore implements OnModuleInit {
  private readonly log = new Logger(AgentPermissionStore.name);
  private readonly byUser = new Map<string, Map<AgentPermissionScope, AgentPermissionGrant>>();

  constructor(
    @Optional() @Inject(POSTGRES_POOL) private readonly pool?: Pool,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.pool) return;
    try {
      // Defensive bootstrap for local/dev + isolated unit scenarios where the
      // SQL bootstrap migration may not have run yet. Canonical schema lives in
      // infra/postgres/init/001-schema.sql.
      await this.pool.query(
        `CREATE TABLE IF NOT EXISTS agent_permission_grants (
           user_id TEXT NOT NULL,
           scope TEXT NOT NULL,
           expires_at TIMESTAMPTZ,
           granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
           PRIMARY KEY (user_id, scope)
         )`,
      );
      const result = await this.pool.query<{
        user_id: string;
        scope: string;
        expires_at: Date | null;
        granted_at: Date;
      }>(
        `SELECT user_id, scope, expires_at, granted_at
           FROM agent_permission_grants
          WHERE expires_at IS NULL OR expires_at > now()`,
      );
      for (const row of result.rows) {
        const scope = validateScope(row.scope);
        this.upsertLocal({
          userId: row.user_id,
          scope,
          expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
          grantedAt: row.granted_at.toISOString(),
        });
      }
      this.log.log(`loaded ${result.rows.length} agent permission grants from Postgres`);
    } catch (err) {
      this.log.warn(
        `failed to initialize durable agent permissions (continuing in in-memory mode): ${(err as Error).message}`,
      );
    }
  }

  grant(
    userId: string,
    scope: AgentPermissionScope,
    opts: { expiresAt?: string | null } = {},
  ): AgentPermissionGrant {
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new BadRequestException('grant: userId is required');
    }
    const validated = validateScope(scope);
    const expiresAt = opts.expiresAt ?? null;
    if (expiresAt !== null) {
      const t = Date.parse(expiresAt);
      if (Number.isNaN(t)) {
        throw new BadRequestException(`grant: expiresAt must be a valid ISO-8601 timestamp`);
      }
    }
    const grant: AgentPermissionGrant = {
      userId,
      scope: validated,
      expiresAt,
      grantedAt: new Date().toISOString(),
    };
    this.upsertLocal(grant);
    // Persist asynchronously to preserve the existing synchronous API surface
    // used throughout AgentService/controller paths. This is intentionally
    // eventually consistent across process crashes.
    void this.persistGrant(grant);
    return grant;
  }

  revoke(userId: string, scope: AgentPermissionScope): boolean {
    const userMap = this.byUser.get(userId);
    if (!userMap) return false;
    const removed = userMap.delete(scope);
    if (userMap.size === 0) this.byUser.delete(userId);
    if (removed) void this.deleteGrant(userId, scope);
    return removed;
  }

  list(userId: string): AgentPermissionGrant[] {
    return [...(this.byUser.get(userId)?.values() ?? [])].filter((g) => !this.expired(g));
  }

  /** Check if `userId` holds an unexpired grant for `scope`. Wildcard scopes
   *  (e.g. `agent:ingest:*`) match any concrete `agent:ingest:<x>`. */
  has(userId: string, scope: AgentPermissionScope): boolean {
    const userMap = this.byUser.get(userId);
    if (!userMap) return false;
    const exact = userMap.get(scope);
    if (exact && !this.expired(exact)) return true;
    if (scope.startsWith('agent:ingest:')) {
      const wildcard = userMap.get('agent:ingest:*' as AgentPermissionScope);
      if (wildcard && !this.expired(wildcard)) return true;
    }
    return false;
  }

  private expired(grant: AgentPermissionGrant): boolean {
    if (!grant.expiresAt) return false;
    return new Date(grant.expiresAt).getTime() <= Date.now();
  }

  private upsertLocal(grant: AgentPermissionGrant): void {
    const userMap = this.byUser.get(grant.userId) ?? new Map();
    userMap.set(grant.scope, grant);
    this.byUser.set(grant.userId, userMap);
  }

  private async persistGrant(grant: AgentPermissionGrant): Promise<void> {
    if (!this.pool) return;
    try {
      await this.pool.query(
        `INSERT INTO agent_permission_grants (user_id, scope, expires_at, granted_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, scope)
         DO UPDATE SET expires_at = EXCLUDED.expires_at, granted_at = EXCLUDED.granted_at`,
        [grant.userId, grant.scope, grant.expiresAt, grant.grantedAt],
      );
    } catch (err) {
      this.log.warn(`failed to persist agent permission grant: ${(err as Error).message}`);
    }
  }

  private async deleteGrant(userId: string, scope: AgentPermissionScope): Promise<void> {
    if (!this.pool) return;
    try {
      await this.pool.query(
        `DELETE FROM agent_permission_grants WHERE user_id = $1 AND scope = $2`,
        [userId, scope],
      );
    } catch (err) {
      this.log.warn(`failed to delete agent permission grant: ${(err as Error).message}`);
    }
  }
}
