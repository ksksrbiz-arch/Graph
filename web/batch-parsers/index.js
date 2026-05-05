// Batch upload orchestrator. Coordinates file-walking → filtering → per-file
// parsing → folder/file-node skeleton → cross-file edge resolution.
//
// Public API:
//   - planFiles(files, opts)    → { kept, skipped, totalBytes, byExt }
//   - parseAll(kept, opts)      → async generator yielding { nodes, edges, progress }
//
// The orchestrator emits the canonical graph skeleton documented in the plan:
//
//   <source>     ──CONTAINS──>     <folder>      ──CONTAINS──>     <folder/file>
//                                                                       ▲
//                          <parser-emitted node> ──EXTRACTED_FROM──┘
//                          <file>                ──IMPORTS / REFERENCES──>  <module / file>
//
// IDs are deterministic for a given (sourceId, relativePath, role) tuple, so
// re-uploading the same folder merges into the existing nodes via
// `mergeAndPersist` in src/worker.js instead of creating duplicates.

import { dirname, extOf, looksBinary, makeEdge, makeNode, readFileAsText } from './util.js';
import {
  parseCsvFile,
  parseHtmlFile,
  parseJsonFile,
  parseMarkdownFile,
  parseSourceFile,
  parseTextFile,
  parseTsvFile,
} from './parsers.js';

// Hard caps — chosen to leave headroom under the 5 000-node / 20 000-edge per-
// request server limits even with many tags/headings per file.
export const DEFAULT_LIMITS = Object.freeze({
  maxFiles: 1_000,
  maxTotalBytes: 20 * 1024 * 1024, // 20 MiB total
  maxFileBytes: 1 * 1024 * 1024, //   1 MiB per file
});

// Folders that almost never contain useful data and routinely contain
// thousands of generated files. Skipped before we even read the file.
export const IGNORED_DIR_SEGMENTS = Object.freeze([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.nuxt',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  '.cache',
  '.idea',
  '.vscode',
  'coverage',
  '.gradle',
  '.mvn',
  'vendor',
]);

// Source-code extensions handled by the regex-based source parser.
const SOURCE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx',
  '.py', '.go', '.java', '.rb', '.rs', '.cs',
  '.c', '.h', '.cpp', '.cc', '.hpp', '.hh',
  '.sh', '.bash', '.zsh',
]);

// Other file extensions we know how to parse. Anything textual not in either
// set falls through to the plain-text fallback (small files only).
const PARSER_BY_EXT = new Map([
  ['.md', 'markdown'],
  ['.markdown', 'markdown'],
  ['.txt', 'text'],
  ['.log', 'text'],
  ['.rst', 'text'],
  ['.html', 'html'],
  ['.htm', 'html'],
  ['.json', 'json'],
  ['.csv', 'csv'],
  ['.tsv', 'tsv'],
]);

/**
 * Decide which files go through the pipeline and which are skipped.
 *
 * @param {Array<{file: File, relativePath: string}>} files
 * @param {object} [opts]
 * @param {object} [opts.limits]
 * @returns {{kept: Array, skipped: Array, totalBytes: number, byExt: Record<string, {count:number, bytes:number}>}}
 */
export function planFiles(files, opts = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(opts.limits || {}) };
  const kept = [];
  const skipped = [];
  const byExt = Object.create(null);
  let totalBytes = 0;

  for (const entry of files) {
    const path = entry.relativePath || entry.file?.webkitRelativePath || entry.file?.name || '';
    const size = entry.file?.size ?? 0;
    const ext = extOf(path);

    let reason = null;
    if (isIgnoredPath(path)) reason = 'ignored path';
    else if (size > limits.maxFileBytes) reason = `> ${formatBytes(limits.maxFileBytes)}`;
    else if (kept.length >= limits.maxFiles) reason = `> ${limits.maxFiles} files`;
    else if (totalBytes + size > limits.maxTotalBytes) reason = `> ${formatBytes(limits.maxTotalBytes)} total`;
    else if (!isLikelyTextual(ext, path)) reason = 'binary';

    if (reason) {
      skipped.push({ file: entry.file, relativePath: path, ext, reason });
      continue;
    }

    kept.push({ file: entry.file, relativePath: path, ext });
    totalBytes += size;
    const slot = (byExt[ext || '(none)'] ||= { count: 0, bytes: 0 });
    slot.count += 1;
    slot.bytes += size;
  }

  return { kept, skipped, totalBytes, byExt };
}

/**
 * Run the full pipeline. Yields incremental progress so the UI can update a
 * progress bar without waiting for the whole batch to finish.
 *
 * @param {{file: File, relativePath: string, ext: string}[]} kept
 * @param {{ sourceId: string, sourceLabel: string, signal?: AbortSignal, onProgress?: Function }} opts
 * @returns {Promise<{nodes: any[], edges: any[], stats: any}>}
 */
export async function parseAll(kept, opts) {
  const { sourceId, sourceLabel, signal, onProgress } = opts;
  const now = new Date().toISOString();
  const ctxBase = { sourceId, now };

  const allNodes = [];
  const allEdges = [];
  const fileNodeByPath = new Map();
  const folderNodeByPath = new Map();
  const importsByPath = new Map();

  // Synthetic source node — anchors the whole upload.
  const sourceNode = await makeNode(
    { ...ctxBase, relativePath: '' },
    {
      idParts: ['source-root'],
      label: sourceLabel || sourceId,
      type: 'source',
      metadata: { kind: 'batch-upload', uploadedAt: now },
    },
  );
  allNodes.push(sourceNode);

  let processed = 0;
  let parseFailures = 0;
  const total = kept.length;

  for (const item of kept) {
    if (signal?.aborted) throw new DOMException('Upload aborted', 'AbortError');

    const folderId = await ensureFolderChain(item.relativePath, ctxBase, sourceNode.id, folderNodeByPath, allNodes, allEdges);
    const fileNode = await makeNode(
      { ...ctxBase, relativePath: item.relativePath },
      {
        idParts: ['file', item.relativePath],
        label: basenameOf(item.relativePath),
        type: 'file',
        metadata: {
          path: item.relativePath,
          ext: item.ext,
          bytes: item.file.size,
        },
      },
    );
    allNodes.push(fileNode);
    fileNodeByPath.set(item.relativePath, fileNode.id);

    const eFile = await makeEdge(
      { ...ctxBase, relativePath: item.relativePath },
      { source: folderId, target: fileNode.id, relation: 'CONTAINS', weight: 0.7 },
    );
    if (eFile) allEdges.push(eFile);

    // Read + parse. Read errors are non-fatal — we still keep the file node.
    let text = '';
    try {
      // Defensive binary recheck (planFiles rejects most binaries, but `.txt`
      // can still be a renamed image, etc.). Skip silently rather than
      // pollute the graph with junk paragraphs.
      if (await looksBinary(item.file)) {
        parseFailures += 1;
      } else {
        text = await readFileAsText(item.file);
      }
    } catch {
      parseFailures += 1;
    }

    if (text) {
      const fileCtx = {
        relativePath: item.relativePath,
        sourceId,
        fileNodeId: fileNode.id,
        now,
      };
      try {
        const fragment = await dispatchParse(text, fileCtx, item.ext);
        if (fragment.nodes?.length) allNodes.push(...fragment.nodes);
        if (fragment.edges?.length) allEdges.push(...fragment.edges);
        if (fragment.imports?.length) importsByPath.set(item.relativePath, fragment.imports);
      } catch (err) {
        parseFailures += 1;
        // eslint-disable-next-line no-console
        console.warn(`[batch-upload] parser failed for ${item.relativePath}:`, err);
      }
    }

    processed += 1;
    if (onProgress) {
      try {
        onProgress({
          processed,
          total,
          path: item.relativePath,
          nodes: allNodes.length,
          edges: allEdges.length,
        });
      } catch { /* swallow UI callback errors */ }
    }
  }

  // Resolve relative imports → file→file REFERENCES edges so the graph shows
  // module structure, not just isolated module nodes. Bare-package imports
  // (e.g. `react`, `os`) keep their synthetic module-node form.
  for (const [fromPath, imports] of importsByPath) {
    for (const mod of imports) {
      const resolved = resolveRelative(fromPath, mod);
      if (!resolved) continue;
      const targetId = fileNodeByPath.get(resolved);
      if (!targetId) continue;
      const fromId = fileNodeByPath.get(fromPath);
      if (!fromId) continue;
      const e = await makeEdge(
        { ...ctxBase, relativePath: fromPath },
        {
          source: fromId,
          target: targetId,
          relation: 'REFERENCES',
          weight: 0.6,
          metadata: { module: mod },
        },
      );
      if (e) allEdges.push(e);
    }
  }

  return {
    nodes: allNodes,
    edges: allEdges,
    stats: {
      sourceId,
      files: total,
      parseFailures,
      folders: folderNodeByPath.size,
      nodes: allNodes.length,
      edges: allEdges.length,
    },
  };
}

/**
 * Recursively walk a webkit/Chromium directory entry tree (from a drag-drop)
 * into a flat `[{ file, relativePath }]` array. Used by the drop-zone path
 * (the `<input webkitdirectory>` path is already flat via `webkitRelativePath`).
 */
export async function walkDirectoryEntry(entry, prefix = '') {
  if (!entry) return [];
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    return [{ file, relativePath }];
  }
  if (entry.isDirectory) {
    const reader = entry.createReader();
    const out = [];
    // readEntries returns chunks (typically up to 100 entries per call); keep
    // calling until empty. A safety counter guards against a misbehaving
    // implementation that never returns an empty batch.
    const MAX_BATCHES = 1_000;
    for (let i = 0; i < MAX_BATCHES; i++) {
      // eslint-disable-next-line no-await-in-loop
      const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      if (!batch.length) break;
      // eslint-disable-next-line no-await-in-loop
      for (const child of batch) {
        // eslint-disable-next-line no-await-in-loop
        out.push(...(await walkDirectoryEntry(child, prefix ? `${prefix}/${entry.name}` : entry.name)));
      }
    }
    return out;
  }
  return [];
}

// ── internals ──────────────────────────────────────────────────────────

async function dispatchParse(text, ctx, ext) {
  if (SOURCE_EXTENSIONS.has(ext)) return parseSourceFile(text, ctx, ext);
  const kind = PARSER_BY_EXT.get(ext);
  switch (kind) {
    case 'markdown': return parseMarkdownFile(text, ctx);
    case 'text': return parseTextFile(text, ctx);
    case 'html': return parseHtmlFile(text, ctx);
    case 'json': return parseJsonFile(text, ctx);
    case 'csv': return parseCsvFile(text, ctx);
    case 'tsv': return parseTsvFile(text, ctx);
    default: return parseTextFile(text, ctx); // fallback
  }
}

async function ensureFolderChain(filePath, ctxBase, sourceNodeId, cache, nodes, edges) {
  const dir = dirname(filePath);
  if (!dir) return sourceNodeId;
  if (cache.has(dir)) return cache.get(dir);

  const segments = dir.split('/').filter(Boolean);
  let parentId = sourceNodeId;
  let acc = '';
  for (const seg of segments) {
    acc = acc ? `${acc}/${seg}` : seg;
    if (cache.has(acc)) {
      parentId = cache.get(acc);
      continue;
    }
    const node = await makeNode(
      { ...ctxBase, relativePath: acc },
      {
        idParts: ['folder', acc],
        label: seg,
        type: 'folder',
        metadata: { path: acc },
      },
    );
    nodes.push(node);
    const e = await makeEdge(
      { ...ctxBase, relativePath: acc },
      { source: parentId, target: node.id, relation: 'CONTAINS', weight: 0.6 },
    );
    if (e) edges.push(e);
    cache.set(acc, node.id);
    parentId = node.id;
  }
  return parentId;
}

function isIgnoredPath(path) {
  const segs = String(path || '').split('/');
  for (const seg of segs) {
    if (IGNORED_DIR_SEGMENTS.includes(seg)) return true;
    // Lockfiles / build artefacts keyed on basename
    if (LOCKFILES.has(seg)) return true;
  }
  return false;
}

const LOCKFILES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'poetry.lock',
  'Pipfile.lock',
  'Cargo.lock',
  'go.sum',
  'composer.lock',
  'Gemfile.lock',
]);

function isLikelyTextual(ext, path) {
  if (SOURCE_EXTENSIONS.has(ext)) return true;
  if (PARSER_BY_EXT.has(ext)) return true;
  // Common config / dotfile extensions worth ingesting as plain text.
  if (
    ext === '.yml' || ext === '.yaml' || ext === '.toml' || ext === '.ini' ||
    ext === '.env' || ext === '.cfg' || ext === '.conf' || ext === '.xml' ||
    ext === '.svg' || ext === '.sql' || ext === '.gql' || ext === '.graphql'
  ) return true;
  // Extensionless textual files (README, LICENSE, Makefile, …).
  if (!ext) {
    const base = basenameOf(path).toLowerCase();
    if (
      base === 'readme' || base === 'license' || base === 'licence' ||
      base === 'changelog' || base === 'authors' || base === 'contributors' ||
      base === 'makefile' || base === 'dockerfile' || base === 'jenkinsfile'
    ) return true;
  }
  return false;
}

function basenameOf(path) {
  const segs = String(path || '').split('/').filter(Boolean);
  return segs[segs.length - 1] || path || '';
}

/** Resolve `./foo` / `../bar` against a from-file path. Returns the resolved
 *  relative path with one of the candidate extensions tried, or null. */
function resolveRelative(fromPath, mod) {
  if (!mod || (!mod.startsWith('./') && !mod.startsWith('../'))) return null;
  const fromDir = dirname(fromPath).split('/').filter(Boolean);
  const targetSegs = mod.split('/');
  const stack = [...fromDir];
  for (const seg of targetSegs) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') stack.pop();
    else stack.push(seg);
  }
  return stack.join('/') || null;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

export const __test__ = { isIgnoredPath, isLikelyTextual, resolveRelative };
