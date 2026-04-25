import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

export const SCHEMA_VERSION = 1;

export function emptyGraph() {
  return {
    schemaVersion: SCHEMA_VERSION,
    metadata: { createdAt: new Date().toISOString(), updatedAt: null, sources: [] },
    nodes: [],
    edges: [],
  };
}

export async function loadGraph(path) {
  try {
    const txt = await readFile(path, 'utf8');
    const parsed = JSON.parse(txt);
    if (!parsed.nodes || !parsed.edges) return emptyGraph();
    return parsed;
  } catch (err) {
    if (err.code === 'ENOENT') return emptyGraph();
    throw err;
  }
}

export async function saveGraph(path, graph) {
  graph.metadata = graph.metadata || {};
  graph.metadata.updatedAt = new Date().toISOString();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(graph, null, 2) + '\n', 'utf8');
}

export class GraphBuilder {
  constructor(existing = emptyGraph()) {
    this.graph = existing;
    this.nodeIndex = new Map(existing.nodes.map((n) => [n.id, n]));
    this.edgeIndex = new Map(existing.edges.map((e) => [e.id, e]));
  }

  upsertNode(node) {
    const id = node.id || stableId(node.type, node.naturalKey || node.label);
    const now = new Date().toISOString();
    const existing = this.nodeIndex.get(id);
    if (existing) {
      existing.label = node.label ?? existing.label;
      existing.metadata = { ...existing.metadata, ...(node.metadata || {}) };
      existing.updatedAt = now;
      if (node.createdAt && (!existing.createdAt || node.createdAt < existing.createdAt)) {
        existing.createdAt = node.createdAt;
      }
      return existing;
    }
    const created = {
      id,
      label: node.label || id,
      type: node.type,
      sourceId: node.sourceId || 'unknown',
      sourceUrl: node.sourceUrl,
      createdAt: node.createdAt || now,
      updatedAt: now,
      metadata: node.metadata || {},
    };
    this.graph.nodes.push(created);
    this.nodeIndex.set(id, created);
    return created;
  }

  upsertEdge({ source, target, relation, weight = 0.5, metadata = {} }) {
    if (!source || !target || source === target) return null;
    const id = `${source}|${relation}|${target}`;
    const existing = this.edgeIndex.get(id);
    if (existing) {
      existing.weight = Math.min(1, existing.weight + weight * 0.25);
      existing.metadata = { ...existing.metadata, ...metadata };
      existing.metadata.count = (existing.metadata.count || 1) + 1;
      return existing;
    }
    const edge = {
      id,
      source,
      target,
      relation,
      weight: Math.max(0, Math.min(1, weight)),
      inferred: false,
      createdAt: new Date().toISOString(),
      metadata: { count: 1, ...metadata },
    };
    this.graph.edges.push(edge);
    this.edgeIndex.set(id, edge);
    return edge;
  }

  recordSource(name, info = {}) {
    this.graph.metadata = this.graph.metadata || { sources: [] };
    this.graph.metadata.sources = this.graph.metadata.sources || [];
    const idx = this.graph.metadata.sources.findIndex((s) => s.name === name);
    const entry = { name, lastRunAt: new Date().toISOString(), ...info };
    if (idx >= 0) this.graph.metadata.sources[idx] = entry;
    else this.graph.metadata.sources.push(entry);
  }
}

export function stableId(type, key) {
  const h = createHash('sha1').update(`${type}::${key}`).digest('hex').slice(0, 16);
  return `${type}_${h}`;
}
