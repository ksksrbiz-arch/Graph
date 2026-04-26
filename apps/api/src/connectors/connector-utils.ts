// Helpers shared by every concrete connector. Keeps individual connectors
// terse and consistent in how they spit IDs / dates / rate-limit info back
// out to the sync orchestrator.

import { createHash, randomUUID } from 'node:crypto';
import type { ConnectorId } from '@pkg/shared';

/** Stable v4-shaped UUID derived from a connector + external id. Lets two
 *  syncs of the same upstream item produce the same node id, which is the
 *  cornerstone of Rule 12 (idempotent syncs). The output is not a proper
 *  RFC 4122 v5 (no namespace) but matches the v4 layout zod's `.uuid()`
 *  validator accepts. */
export function deterministicUuid(
  connectorId: ConnectorId,
  externalId: string,
): string {
  const h = createHash('sha256')
    .update(`${connectorId}:${externalId}`)
    .digest('hex');
  const variantNibble = '89ab'[parseInt(h.charAt(16), 16) & 3] ?? '8';
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `4${h.slice(13, 16)}`,
    `${variantNibble}${h.slice(17, 20)}`,
    h.slice(20, 32),
  ].join('-');
}

export function newEdgeId(): string {
  return randomUUID();
}

export function isoNow(): string {
  return new Date().toISOString();
}

export interface RateLimitSnapshot {
  remaining?: number;
  resetsAt?: string;
}

/** Pull rate-limit headers off a fetch Response. GitHub uses
 *  `x-ratelimit-remaining` / `x-ratelimit-reset` (epoch seconds); Notion uses
 *  `retry-after` (seconds). Other providers fall through to undefined. */
export function readRateLimit(res: Response): RateLimitSnapshot {
  const remainingRaw = res.headers.get('x-ratelimit-remaining');
  const resetRaw = res.headers.get('x-ratelimit-reset');
  const retryAfter = res.headers.get('retry-after');
  const out: RateLimitSnapshot = {};
  if (remainingRaw !== null) {
    const n = Number(remainingRaw);
    if (Number.isFinite(n)) out.remaining = n;
  }
  if (resetRaw !== null) {
    const epoch = Number(resetRaw);
    if (Number.isFinite(epoch)) {
      out.resetsAt = new Date(epoch * 1000).toISOString();
    }
  } else if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      out.resetsAt = new Date(Date.now() + seconds * 1000).toISOString();
    }
  }
  return out;
}

/**
 * Wrap fetch with a tiny "throw on non-2xx" semantic and surface the rate-limit
 * snapshot so the calling connector can stash it on its ConnectorConfig.
 */
export async function authedFetch(
  url: string,
  accessToken: string,
  init: RequestInit & { tokenScheme?: 'bearer' | 'token' } = {},
): Promise<{ res: Response; rate: RateLimitSnapshot }> {
  const scheme = init.tokenScheme ?? 'bearer';
  const headers = new Headers(init.headers);
  if (!headers.has('authorization')) {
    headers.set(
      'authorization',
      scheme === 'token' ? `token ${accessToken}` : `Bearer ${accessToken}`,
    );
  }
  if (!headers.has('accept')) headers.set('accept', 'application/json');
  const { tokenScheme: _ignored, ...rest } = init;
  void _ignored;
  const res = await fetch(url, { ...rest, headers });
  return { res, rate: readRateLimit(res) };
}
