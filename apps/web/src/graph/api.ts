// Thin REST client for the graph canvas. Phase-0 anon mode: every call carries
// `?userId=<id>` and no Authorization header, which the API's JwtAuthGuard
// accepts (see apps/api/src/auth/guards/jwt-auth.guard.ts).

import type { KGNode, KGEdge, Subgraph } from '@pkg/shared';

const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? '/api/v1';

export interface GraphSnapshot {
  schemaVersion: number;
  metadata: { updatedAt: string; userId: string; sources: string[] };
  nodes: KGNode[];
  edges: KGEdge[];
}

export interface GraphDelta {
  schemaVersion: number;
  metadata: { ts: string; userId: string; since: string };
  nodes: KGNode[];
  edges: KGEdge[];
}

function withUser(path: string, userId: string, extra?: Record<string, string>): string {
  const url = new URL(`${API_BASE}${path}`, window.location.origin);
  url.searchParams.set('userId', userId);
  for (const [k, v] of Object.entries(extra ?? {})) url.searchParams.set(k, v);
  // Return path+query only so the dev proxy / same-origin deploy both work.
  return `${url.pathname}${url.search}`;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

/** Full graph snapshot for a user (public/demo path — no auth required). */
export function fetchSnapshot(userId: string): Promise<GraphSnapshot> {
  return getJson<GraphSnapshot>(withUser('/public/graph', userId));
}

/** Nodes + edges created after `sinceIso`. Drives the live poll loop. */
export function fetchDelta(userId: string, sinceIso: string): Promise<GraphDelta> {
  return getJson<GraphDelta>(withUser('/public/graph/delta', userId, { since: sinceIso }));
}

/** Depth-limited ego-network around a node (double-click focus). */
export function fetchSubgraph(userId: string, rootId: string, depth = 2): Promise<Subgraph> {
  return getJson<Subgraph>(withUser('/graph/subgraph', userId, { rootId, depth: String(depth) }));
}

/** Full-text node search (Meilisearch-backed). */
export function searchNodes(userId: string, q: string, limit = 20): Promise<KGNode[]> {
  return getJson<KGNode[]>(withUser('/graph/search', userId, { q, limit: String(limit) }));
}

export interface GraphIngestResult {
  userId: string;
  sourceId: string;
  nodes: number;
  edges: number;
  skippedNodes: number;
  skippedEdges: number;
  brainQueuedReload: boolean;
}

/** Ingest a pre-parsed `{nodes, edges}` fragment (batch folder upload). */
export async function ingestGraph(
  userId: string,
  payload: { nodes: KGNode[]; edges: KGEdge[]; sourceId?: string },
): Promise<GraphIngestResult> {
  const res = await fetch(withUser('/public/ingest/graph', userId), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId, ...payload }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `HTTP ${res.status}`);
  }
  return (await res.json()) as GraphIngestResult;
}

/** Delete a node. Returns true on success (204). */
export async function deleteNode(userId: string, id: string): Promise<void> {
  const res = await fetch(withUser(`/graph/nodes/${encodeURIComponent(id)}`, userId), {
    method: 'DELETE',
  });
  if (!res.ok && res.status !== 204) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `HTTP ${res.status}`);
  }
}
