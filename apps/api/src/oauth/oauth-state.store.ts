// In-memory store of pending OAuth handshakes. The `state` parameter we send
// to the provider doubles as the lookup key on the way back. Entries expire
// after STATE_TTL_MS to bound memory and to refuse late callbacks.
//
// Phase 1+: swap for a Redis-backed store so multiple API instances can share
// state. The interface is intentionally narrow (`put` / `take` / `prune`) so
// the swap is a one-file change.

import { Injectable, Logger } from '@nestjs/common';
import type { ConnectorId } from '@pkg/shared';

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

const STATE_TTL_MS = 10 * 60_000;

@Injectable()
export class OAuthStateStore {
  private readonly log = new Logger(OAuthStateStore.name);
  private readonly entries = new Map<string, OAuthState>();
  private readonly pruneTimer: NodeJS.Timeout;

  constructor() {
    this.pruneTimer = setInterval(() => this.prune(), 60_000);
    // Don't keep the event loop alive just for state cleanup.
    if (typeof this.pruneTimer.unref === 'function') this.pruneTimer.unref();
  }

  put(entry: OAuthState): void {
    this.entries.set(entry.state, entry);
  }

  /** Atomically read-and-delete by state. Returns undefined if missing or
   *  expired — both must be treated as a CSRF failure by the caller. */
  take(state: string): OAuthState | undefined {
    const e = this.entries.get(state);
    if (!e) return undefined;
    this.entries.delete(state);
    if (Date.now() - e.createdAt > STATE_TTL_MS) {
      this.log.warn(`oauth state expired connector=${e.connectorId}`);
      return undefined;
    }
    return e;
  }

  prune(): void {
    const cutoff = Date.now() - STATE_TTL_MS;
    for (const [k, v] of this.entries) {
      if (v.createdAt < cutoff) this.entries.delete(k);
    }
  }

  /** Test-only: drop every pending handshake. */
  clear(): void {
    this.entries.clear();
  }
}
