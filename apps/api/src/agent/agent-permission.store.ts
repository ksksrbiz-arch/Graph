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

import { BadRequestException, Injectable } from '@nestjs/common';

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
export class AgentPermissionStore {
  private readonly byUser = new Map<string, Map<AgentPermissionScope, AgentPermissionGrant>>();

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
    const userMap = this.byUser.get(userId) ?? new Map();
    userMap.set(validated, grant);
    this.byUser.set(userId, userMap);
    return grant;
  }

  revoke(userId: string, scope: AgentPermissionScope): boolean {
    const userMap = this.byUser.get(userId);
    if (!userMap) return false;
    const removed = userMap.delete(scope);
    if (userMap.size === 0) this.byUser.delete(userId);
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
}
