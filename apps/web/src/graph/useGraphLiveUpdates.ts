// Live graph updates hook: polls the delta endpoint on an interval and feeds
// only newly-arrived nodes/edges to a caller-supplied callback. Self-contained;
// the GraphView coordinator wires it. See `fetchDelta` in ./api.ts.

import { useEffect, useRef } from 'react';

import type { KGNode, KGEdge } from '@pkg/shared';

import { fetchDelta } from './api';

export interface UseGraphLiveUpdatesOptions {
  /** Invoked with the nodes/edges that arrived since the last poll. */
  onDelta: (nodes: KGNode[], edges: KGEdge[]) => void;
  /** Poll cadence in milliseconds. Default 3000. */
  intervalMs?: number;
  /** When false, the poll loop is paused (and no fetch is in flight). Default true. */
  enabled?: boolean;
  /** Called when a poll fails, instead of crashing the loop. */
  onError?: (err: unknown) => void;
}

/**
 * Poll `fetchDelta(userId, sinceIso)` on an interval, advancing a `metadata.ts`
 * cursor and forwarding only freshly-arrived nodes/edges to `onDelta`.
 *
 * Behaviour:
 * - Initial cursor is "now" (ISO), so the first poll does not replay history.
 * - Overlapping polls are skipped while one is in flight.
 * - Fetch errors are swallowed (reported via `onError`) and the loop continues.
 * - The interval and any in-flight result are cleaned up on unmount / dep change.
 */
export function useGraphLiveUpdates(
  userId: string,
  options: UseGraphLiveUpdatesOptions,
): void {
  const { onDelta, intervalMs = 3000, enabled = true, onError } = options;

  // Keep the latest callbacks in refs so the effect doesn't re-subscribe (and
  // reset the cursor) every render when the caller passes inline functions.
  const onDeltaRef = useRef(onDelta);
  const onErrorRef = useRef(onError);
  onDeltaRef.current = onDelta;
  onErrorRef.current = onError;

  useEffect(() => {
    if (!enabled || !userId) return;

    // Cursor starts at "now" so we never replay pre-mount history.
    let cursor = new Date().toISOString();
    let inFlight = false;
    let cancelled = false;

    const poll = async (): Promise<void> => {
      if (inFlight) return; // skip overlapping polls
      inFlight = true;
      try {
        const delta = await fetchDelta(userId, cursor);
        if (cancelled) return;
        // Advance the cursor before dispatching so a throwing callback can't
        // wedge us into reprocessing the same window.
        const nextTs = delta.metadata?.ts;
        if (typeof nextTs === 'string' && nextTs.length > 0) {
          cursor = nextTs;
        }
        if (delta.nodes.length > 0 || delta.edges.length > 0) {
          onDeltaRef.current(delta.nodes, delta.edges);
        }
      } catch (err) {
        if (!cancelled) onErrorRef.current?.(err);
      } finally {
        inFlight = false;
      }
    };

    const handle = window.setInterval(() => {
      void poll();
    }, intervalMs);

    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [userId, intervalMs, enabled]);
}
