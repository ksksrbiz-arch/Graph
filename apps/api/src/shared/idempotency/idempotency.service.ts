// In-process idempotency cache. Wraps any side-effecting operation so that
// repeating it with the same idempotency key within the TTL window returns the
// cached result instead of re-executing the work.
//
// Two failure modes are handled explicitly:
//
//  • Concurrent duplicates: a second caller arriving while the first is still
//    in-flight awaits the same Promise rather than firing a parallel request.
//  • Errors: failed operations are NOT cached — clients can retry safely.
//
// Storage is in-memory and per-process. A future backing store (Redis) can be
// dropped in by replacing the `entries` map; the public API stays the same.
//
// Scope is mandatory and acts as a namespace — typically `${userId}:${route}`
// — so two unrelated endpoints can't collide on the same key.

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { createHash } from 'node:crypto';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 min

interface CompletedEntry<T = unknown> {
  state: 'completed';
  value: T;
  /** Optional content fingerprint — when supplied, mismatched payloads on the
   *  same key throw rather than returning a stale value. */
  fingerprint?: string;
  expiresAt: number;
}

interface InflightEntry<T = unknown> {
  state: 'inflight';
  promise: Promise<T>;
  fingerprint?: string;
  expiresAt: number;
}

type Entry<T = unknown> = CompletedEntry<T> | InflightEntry<T>;

export interface WithKeyOptions {
  /** Time-to-live in ms. Defaults to 24h. */
  ttlMs?: number;
  /** Optional content payload. Hashed and stored alongside the result so that
   *  reusing an idempotency key with a different payload is detectable —
   *  matches the Stripe / IETF Idempotency-Key contract. */
  payload?: unknown;
}

export class IdempotencyConflictError extends Error {
  constructor(scope: string, key: string) {
    super(
      `idempotency key "${key}" in scope "${scope}" was already used with a different payload`,
    );
    this.name = 'IdempotencyConflictError';
  }
}

@Injectable()
export class IdempotencyService implements OnModuleDestroy {
  private readonly log = new Logger(IdempotencyService.name);
  private readonly entries = new Map<string, Entry>();
  private readonly sweep: NodeJS.Timeout;

  constructor() {
    this.sweep = setInterval(() => this.evictExpired(), SWEEP_INTERVAL_MS);
    // Don't keep the event loop alive solely for the sweeper — Nest's
    // OnModuleDestroy handles graceful shutdown explicitly.
    if (typeof this.sweep.unref === 'function') this.sweep.unref();
  }

  /**
   * Run `fn` at most once per (scope, key). On a duplicate within the TTL,
   * return the cached value. On a duplicate while the original call is still
   * in-flight, await the same Promise.
   *
   * Throws `IdempotencyConflictError` if the same key is reused with a
   * different `payload` than the one that completed it.
   */
  async withKey<T>(
    scope: string,
    key: string,
    fn: () => Promise<T>,
    opts: WithKeyOptions = {},
  ): Promise<T> {
    const cacheKey = this.cacheKey(scope, key);
    const fingerprint = opts.payload === undefined ? undefined : fingerprintOf(opts.payload);
    const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
    const now = Date.now();

    const existing = this.entries.get(cacheKey);
    if (existing && existing.expiresAt > now) {
      if (
        fingerprint !== undefined &&
        existing.fingerprint !== undefined &&
        existing.fingerprint !== fingerprint
      ) {
        throw new IdempotencyConflictError(scope, key);
      }
      if (existing.state === 'completed') {
        return existing.value as T;
      }
      return existing.promise as Promise<T>;
    }

    const promise = (async () => fn())();
    const inflight: InflightEntry<T> = {
      state: 'inflight',
      promise,
      ...(fingerprint !== undefined ? { fingerprint } : {}),
      expiresAt: now + ttl,
    };
    this.entries.set(cacheKey, inflight as Entry);

    try {
      const value = await promise;
      const completed: CompletedEntry<T> = {
        state: 'completed',
        value,
        ...(fingerprint !== undefined ? { fingerprint } : {}),
        expiresAt: Date.now() + ttl,
      };
      this.entries.set(cacheKey, completed as Entry);
      return value;
    } catch (err) {
      // Don't cache failures — caller is free to retry without changing keys.
      this.entries.delete(cacheKey);
      throw err;
    }
  }

  /** True if the key has been seen and its entry has not yet expired. */
  has(scope: string, key: string): boolean {
    const entry = this.entries.get(this.cacheKey(scope, key));
    return Boolean(entry && entry.expiresAt > Date.now());
  }

  /** Drop a single entry. Useful for manual cache invalidation in tests. */
  forget(scope: string, key: string): boolean {
    return this.entries.delete(this.cacheKey(scope, key));
  }

  /** Purge every entry for a scope — typically called on user logout / GDPR
   *  delete so that idempotency tokens scoped to that user vanish promptly. */
  forgetScope(scope: string): number {
    const prefix = `${scope}::`;
    let removed = 0;
    for (const k of this.entries.keys()) {
      if (k.startsWith(prefix)) {
        this.entries.delete(k);
        removed += 1;
      }
    }
    return removed;
  }

  size(): number {
    return this.entries.size;
  }

  onModuleDestroy(): void {
    clearInterval(this.sweep);
    this.entries.clear();
  }

  private cacheKey(scope: string, key: string): string {
    return `${scope}::${key}`;
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [k, entry] of this.entries) {
      if (entry.expiresAt <= now && entry.state !== 'inflight') {
        this.entries.delete(k);
      }
    }
  }
}

/** SHA-256 hex digest of a stable JSON encoding of `value`. Object keys are
 *  sorted so `{a:1,b:2}` and `{b:2,a:1}` collide as expected. */
export function fingerprintOf(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}
