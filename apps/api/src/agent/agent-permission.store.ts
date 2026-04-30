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

import { Injectable } from '@nestjs/common';

export type AgentPermissionScope =
  | 'agent:enact-motor'
  | 'agent:investigate'
  | 'agent:predict-links'
  | 'agent:propose-edge'
  | `agent:ingest:${string}`;

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
    const grant: AgentPermissionGrant = {
      userId,
      scope,
      expiresAt: opts.expiresAt ?? null,
      grantedAt: new Date().toISOString(),
    };
    const userMap = this.byUser.get(userId) ?? new Map();
    userMap.set(scope, grant);
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
