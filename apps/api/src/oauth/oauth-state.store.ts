// Postgres-backed store of pending OAuth handshakes. The `state` parameter we
// send to the provider doubles as the primary-key lookup on the way back.
// Entries carry an explicit `expires_at` so late callbacks are refused and a
// background prune bounds table growth.
//
// Persisting in Postgres (rather than an in-memory Map) means PKCE verifiers /
// CSRF state survive a process restart and are shared across API instances —
// without it, any callback that lands on a different instance (or after a
// redeploy) would fail. The DDL lives in
// infra/postgres/init/001-schema.sql (`oauth_states`).
//
// The interface stays narrow (`put` / `take` / `prune`) so callers don't care
// about the backing store; the methods are async because the I/O is.

import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import type { ConnectorId } from '@pkg/shared';
import { POSTGRES_POOL } from '../shared/postgres/postgres.module';

export interface OAuthState {
  state: string;
  userId: string;
  connectorId: ConnectorId;
  /** Exact redirect_uri used in authorize request; must be replayed at token exchange. */
  redirectUri: string;
  /** PKCE verifier — only set when the provider supports PKCE. */
  codeVerifier?: string;
  /** Final redirect target (e.g. the SPA route to land on after success). */
  returnTo?: string;
  createdAt: number;
}

interface OAuthStateRow {
  state: string;
  user_id: string;
  connector_id: string;
  redirect_uri: string;
  code_verifier: string | null;
  return_to: string | null;
  created_at: Date;
  expires_at: Date;
}

const STATE_TTL_MS = 10 * 60_000;
const PRUNE_INTERVAL_MS = 60_000;

@Injectable()
export class OAuthStateStore implements OnModuleDestroy {
  private readonly log = new Logger(OAuthStateStore.name);
  private readonly pruneTimer: NodeJS.Timeout;

  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {
    this.pruneTimer = setInterval(() => {
      void this.prune().catch((err: unknown) => {
        this.log.warn(`oauth state prune failed: ${String(err)}`);
      });
    }, PRUNE_INTERVAL_MS);
    // Don't keep the event loop alive just for state cleanup.
    if (typeof this.pruneTimer.unref === 'function') this.pruneTimer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.pruneTimer);
  }

  async put(entry: OAuthState): Promise<void> {
    const expiresAt = new Date(entry.createdAt + STATE_TTL_MS);
    await this.pool.query(
      `INSERT INTO oauth_states
         (state, user_id, connector_id, redirect_uri, code_verifier, return_to, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (state) DO UPDATE SET
         user_id       = EXCLUDED.user_id,
         connector_id  = EXCLUDED.connector_id,
         redirect_uri  = EXCLUDED.redirect_uri,
         code_verifier = EXCLUDED.code_verifier,
         return_to     = EXCLUDED.return_to,
         created_at    = EXCLUDED.created_at,
         expires_at    = EXCLUDED.expires_at`,
      [
        entry.state,
        entry.userId,
        entry.connectorId,
        entry.redirectUri,
        entry.codeVerifier ?? null,
        entry.returnTo ?? null,
        new Date(entry.createdAt),
        expiresAt,
      ],
    );
  }

  /** Atomically read-and-delete by state. Returns undefined if missing or
   *  expired — both must be treated as a CSRF failure by the caller. The
   *  DELETE ... RETURNING guarantees a single-use handshake even under
   *  concurrent callbacks. */
  async take(state: string): Promise<OAuthState | undefined> {
    const result = await this.pool.query<OAuthStateRow>(
      `DELETE FROM oauth_states WHERE state = $1 RETURNING *`,
      [state],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    if (row.expires_at.getTime() <= Date.now()) {
      this.log.warn(`oauth state expired connector=${row.connector_id}`);
      return undefined;
    }
    return this.toState(row);
  }

  async prune(): Promise<void> {
    await this.pool.query(`DELETE FROM oauth_states WHERE expires_at <= now()`);
  }

  /** Test-only: drop every pending handshake. */
  async clear(): Promise<void> {
    await this.pool.query(`DELETE FROM oauth_states`);
  }

  private toState(row: OAuthStateRow): OAuthState {
    return {
      state: row.state,
      userId: row.user_id,
      connectorId: row.connector_id as ConnectorId,
      redirectUri: row.redirect_uri,
      createdAt: row.created_at.getTime(),
      ...(row.code_verifier !== null ? { codeVerifier: row.code_verifier } : {}),
      ...(row.return_to !== null ? { returnTo: row.return_to } : {}),
    };
  }
}
