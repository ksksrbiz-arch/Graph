// Shared utilities for batch-upload parsers.
//
// All parsers receive a context `{ relativePath, sourceId, fileNodeId, now }`
// and return a `{ nodes, edges }` fragment. Node and edge IDs are derived from
// stable inputs (sourceId + relativePath + role + label) so that re-uploading
// the same folder produces the same IDs, letting `mergeAndPersist` (in
// src/worker.js) deduplicate via id-keyed indexes instead of multiplying nodes.

// SHA-256 produces 32 bytes = 64 hex chars — full digest used to derive the UUID-shaped id.

/**
 * SHA-256-derived UUID-shaped string. Mirrors `stableUuid` in
 * src/worker/text-parser.js so client-emitted IDs are interchangeable with
 * server-emitted ones (both are valid 36-char "v4-shaped" UUIDs).
 */
export async function stableId(...parts) {
  const data = new TextEncoder().encode(parts.map(String).join('\u0000'));
  const buf = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(buf);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const variantNibble = '89ab'[parseInt(hex.charAt(16), 16) & 3] ?? '8';
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${variantNibble}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

/** Build a node with `createdAt`/`updatedAt` populated and a stable id. */
export async function makeNode(ctx, { idParts, label, type, metadata, sourceUrl }) {
  const id = await stableId(ctx.sourceId, ...idParts);
  const node = {
    id,
    label: truncate(String(label || id), 200),
    type: String(type || 'note').slice(0, 64),
    sourceId: ctx.sourceId,
    metadata: { ...(metadata || {}) },
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  if (sourceUrl) node.sourceUrl = String(sourceUrl).slice(0, 2048);
  return node;
}

/** Build an edge with a stable id derived from (relation, source, target). */
export async function makeEdge(ctx, { source, target, relation, weight, metadata }) {
  if (!source || !target || source === target) return null;
  const id = await stableId(ctx.sourceId, 'edge', relation, source, target);
  return {
    id,
    source,
    target,
    relation: String(relation || 'RELATED_TO').slice(0, 64),
    weight: clampUnit(weight ?? 0.5),
    inferred: true,
    createdAt: ctx.now,
    metadata: { ...(metadata || {}) },
  };
}

export function truncate(s, n) {
  const str = String(s);
  return str.length <= n ? str : `${str.slice(0, n - 1)}…`;
}

export function clampUnit(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0.5;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/** Read a File/Blob as UTF-8 text. Prefers the modern `Blob.text()` API
 *  (available in every browser that also supports `webkitdirectory` /
 *  `webkitGetAsEntry`, which gates this whole feature) and falls back to
 *  FileReader only if `.text()` is missing. */
export function readFileAsText(file) {
  if (file && typeof file.text === 'function') {
    return file.text();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.readAsText(file);
  });
}

/**
 * Sniff a Blob's first chunk for a NUL byte. Used to skip binaries (images,
 * compiled artefacts, etc.) so we never feed them to a text parser. Cheap —
 * reads up to `bytes` bytes, default 8 KiB.
 */
export async function looksBinary(file, bytes = 8192) {
  try {
    const slice = file.slice(0, Math.min(bytes, file.size));
    const buf = await slice.arrayBuffer();
    const view = new Uint8Array(buf);
    for (let i = 0; i < view.length; i++) {
      if (view[i] === 0x00) return true;
    }
    return false;
  } catch {
    return true; // err on the side of skipping
  }
}

/** Pick the lower-cased extension (with leading dot) or '' for none. */
export function extOf(path) {
  const m = String(path || '').match(/(\.[A-Za-z0-9]+)$/);
  return m ? m[1].toLowerCase() : '';
}

/** Pick the basename of a relative path. */
export function basename(path) {
  const segs = String(path || '').split('/').filter(Boolean);
  return segs[segs.length - 1] || path || '';
}

/** Pick the parent directory of a relative path, or '' for root. */
export function dirname(path) {
  const segs = String(path || '').split('/').filter(Boolean);
  segs.pop();
  return segs.join('/');
}
