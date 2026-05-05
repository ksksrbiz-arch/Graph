// Batch folder upload — UI + orchestration glue for the Brain ingest panel's
// `Batch` tab. Renders a folder picker + drag-drop target, lets the user
// preview which files will be parsed (with reasons for each skipped one),
// then walks the kept files through the parser registry and posts the
// resulting nodes/edges to `/api/v1/public/ingest/graph` in chunks.
//
// Lives alongside (not inside) `web/ingest-panel.js` so the panel module
// stays focused on tab orchestration; the heavy lifting is here.

import { ingestPublicBatch, loadGraph, publicIngestAvailable } from '../data.js';
import { setGraph } from '../state.js';
import { showToast } from '../util.js';
import {
  DEFAULT_LIMITS,
  IGNORED_DIR_SEGMENTS,
  parseAll,
  planFiles,
  walkDirectoryEntry,
} from '../batch-parsers/index.js';

/**
 * Build the `<div class="ingest-tab" data-pane="batch">` panel and return
 * `{ root, reset }`. The caller appends `root` into the panel body and may
 * call `reset()` when navigating away.
 *
 * @param {object} opts
 * @param {(result: any) => void} [opts.onIngested] — called after a successful upload
 * @param {(entry: { source: string, status: 'ok'|'err'|'pending', addedNodes: number }) => void} [opts.onLog]
 */
export function createBatchUploadTab({ onIngested, onLog } = {}) {
  const root = document.createElement('div');
  root.className = 'ingest-tab hidden';
  root.dataset.pane = 'batch';
  root.innerHTML = `
    <div class="batch-dropzone" data-dropzone>
      <p class="batch-dropzone-hint">
        Drop a project folder here, or
        <button type="button" class="ingest-btn batch-pick-btn" data-pick>📁 Pick folder</button>
      </p>
      <input type="file" data-folder-input multiple webkitdirectory directory hidden />
    </div>
    <div class="batch-preflight hidden" data-preflight>
      <div class="batch-summary" data-summary></div>
      <div class="batch-skipped hidden" data-skipped></div>
      <div class="batch-actions">
        <button type="button" class="ingest-btn primary" data-upload>Upload →</button>
        <button type="button" class="ingest-btn" data-cancel>Cancel</button>
      </div>
    </div>
    <div class="batch-progress hidden" data-progress>
      <div class="batch-progress-bar"><div class="batch-progress-fill" data-fill></div></div>
      <div class="batch-progress-text" data-progress-text></div>
      <button type="button" class="ingest-btn batch-abort-btn" data-abort>Abort</button>
    </div>
    <div class="ingest-status" data-status></div>
    <p class="ingest-hint">
      Supported: markdown, text, JSON, CSV/TSV, HTML, source code (JS, TS, Python, Go, Java, Rust, C/C++, Ruby, C#, shell), README/LICENSE, YAML/TOML/INI.
      Skipped: <code>.git</code>, <code>node_modules</code>, <code>dist</code>, <code>build</code>, lockfiles, binaries, and files larger than ${formatBytes(DEFAULT_LIMITS.maxFileBytes)}.
    </p>
  `;

  const dropzone = root.querySelector('[data-dropzone]');
  const pickBtn = root.querySelector('[data-pick]');
  const folderInput = root.querySelector('[data-folder-input]');
  const preflightEl = root.querySelector('[data-preflight]');
  const summaryEl = root.querySelector('[data-summary]');
  const skippedEl = root.querySelector('[data-skipped]');
  const uploadBtn = root.querySelector('[data-upload]');
  const cancelBtn = root.querySelector('[data-cancel]');
  const progressEl = root.querySelector('[data-progress]');
  const progressFill = root.querySelector('[data-fill]');
  const progressText = root.querySelector('[data-progress-text]');
  const abortBtn = root.querySelector('[data-abort]');
  const statusEl = root.querySelector('[data-status]');

  /** @type {{kept: any[], skipped: any[], totalBytes: number, byExt: Record<string,{count:number,bytes:number}>, sourceLabel: string} | null} */
  let plan = null;
  /** @type {AbortController | null} */
  let abortCtl = null;

  pickBtn.addEventListener('click', () => folderInput.click());
  folderInput.addEventListener('change', () => {
    if (!folderInput.files?.length) return;
    const entries = Array.from(folderInput.files).map((file) => ({
      file,
      relativePath: file.webkitRelativePath || file.name,
    }));
    showPreflight(entries);
  });

  // Drag + drop folder support — uses webkitGetAsEntry to walk subdirectories.
  ['dragenter', 'dragover'].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add('batch-dropzone-active');
    });
  });
  ['dragleave', 'drop'].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove('batch-dropzone-active');
    });
  });
  dropzone.addEventListener('drop', async (e) => {
    setStatus('Reading dropped folder…', 'info');
    const items = e.dataTransfer?.items ? Array.from(e.dataTransfer.items) : [];
    const collected = [];
    try {
      for (const item of items) {
        if (item.kind !== 'file') continue;
        const entry = item.webkitGetAsEntry?.();
        if (entry) {
          // eslint-disable-next-line no-await-in-loop
          collected.push(...(await walkDirectoryEntry(entry)));
        } else if (item.getAsFile) {
          const file = item.getAsFile();
          if (file) collected.push({ file, relativePath: file.name });
        }
      }
    } catch (err) {
      setStatus(`Drop failed: ${err.message || err}`, 'err');
      return;
    }
    if (collected.length === 0) {
      setStatus('No files were dropped.', 'warn');
      return;
    }
    showPreflight(collected);
  });

  cancelBtn.addEventListener('click', () => {
    plan = null;
    folderInput.value = '';
    preflightEl.classList.add('hidden');
    summaryEl.innerHTML = '';
    skippedEl.innerHTML = '';
    skippedEl.classList.add('hidden');
    setStatus('', '');
  });

  uploadBtn.addEventListener('click', () => runUpload());
  abortBtn.addEventListener('click', () => {
    abortCtl?.abort();
    setStatus('Aborting…', 'warn');
  });

  function showPreflight(entries) {
    plan = null;
    const planned = planFiles(entries);
    const sourceLabel = inferFolderName(entries) || 'Batch upload';
    plan = { ...planned, sourceLabel };

    summaryEl.innerHTML = renderSummary(planned, sourceLabel);
    if (planned.skipped.length) {
      skippedEl.classList.remove('hidden');
      skippedEl.innerHTML = renderSkipped(planned.skipped);
    } else {
      skippedEl.classList.add('hidden');
      skippedEl.innerHTML = '';
    }
    preflightEl.classList.remove('hidden');
    progressEl.classList.add('hidden');

    if (planned.kept.length === 0) {
      uploadBtn.disabled = true;
      setStatus('Nothing to upload — every file was skipped.', 'warn');
    } else {
      uploadBtn.disabled = false;
      setStatus(
        `Ready: ${planned.kept.length} file(s) / ${formatBytes(planned.totalBytes)} from “${sourceLabel}”.`,
        'info',
      );
    }
  }

  async function runUpload() {
    if (!plan || plan.kept.length === 0) return;
    if (!(await publicIngestAvailable())) {
      setStatus('Public ingest API is not available. Configure apiBaseUrl or run the dev server.', 'err');
      return;
    }

    uploadBtn.disabled = true;
    cancelBtn.disabled = true;
    preflightEl.classList.add('hidden');
    progressEl.classList.remove('hidden');
    abortCtl = new AbortController();
    setStatus('Parsing files…', 'info');

    const sourceId = `batch-${slugify(plan.sourceLabel)}-${shortStamp()}`;

    let parsed;
    try {
      parsed = await parseAll(plan.kept, {
        sourceId,
        sourceLabel: plan.sourceLabel,
        signal: abortCtl.signal,
        onProgress: ({ processed, total, path, nodes, edges }) => {
          updateProgress(processed / Math.max(1, total));
          progressText.textContent = `${processed}/${total} • ${truncateMid(path, 36)} • ${nodes} nodes, ${edges} edges`;
        },
      });
    } catch (err) {
      if (err?.name === 'AbortError') {
        setStatus('Upload aborted.', 'warn');
      } else {
        setStatus(`Parse failed: ${err.message || err}`, 'err');
      }
      finishUpload();
      onLog?.({ source: plan.sourceLabel, status: 'err', addedNodes: 0 });
      return;
    }

    setStatus(
      `Parsed ${parsed.stats.files} files → ${parsed.nodes.length} nodes / ${parsed.edges.length} edges. Uploading…`,
      'info',
    );
    progressText.textContent = 'Uploading…';
    updateProgress(0.95);

    const result = await ingestPublicBatch({
      nodes: parsed.nodes,
      edges: parsed.edges,
      sourceId,
      onChunk: ({ index, total, ok }) => {
        if (!ok) return;
        if (total > 0) {
          updateProgress(0.95 + (0.05 * (index + 1)) / total);
        }
      },
    });

    if (result.ok) {
      updateProgress(1);
      setStatus(
        `✓ Uploaded ${parsed.nodes.length} nodes / ${parsed.edges.length} edges from ${parsed.stats.files} files.`,
        'ok',
      );
      showToast(`Batch upload: ${parsed.stats.files} files`, 'success');
      onIngested?.({ ok: true, nodes: parsed.nodes.length, edges: parsed.edges.length, sourceId });
      onLog?.({ source: plan.sourceLabel, status: 'ok', addedNodes: parsed.nodes.length });
      // Refresh graph so the new nodes light up immediately, mirroring the
      // pattern used by the URL/Text tabs in ingest-panel.js.
      loadGraph().then(setGraph).catch((err) => {
        console.warn('[batch-upload] graph reload failed', err);
      });
    } else {
      setStatus(`✗ Upload failed (${result.status || 'network'}): ${result.error || result.message || 'unknown'}`, 'err');
      onLog?.({ source: plan.sourceLabel, status: 'err', addedNodes: 0 });
    }
    finishUpload();
  }

  function finishUpload() {
    abortCtl = null;
    uploadBtn.disabled = false;
    cancelBtn.disabled = false;
    progressEl.classList.add('hidden');
    plan = null;
    folderInput.value = '';
  }

  function updateProgress(fraction) {
    const pct = Math.max(0, Math.min(1, fraction)) * 100;
    progressFill.style.width = `${pct.toFixed(1)}%`;
  }

  function setStatus(message, kind) {
    statusEl.textContent = message;
    statusEl.className = `ingest-status ${kind || ''}`.trim();
  }

  function reset() {
    cancelBtn.click();
    finishUpload();
    setStatus('', '');
  }

  return { root, reset };
}

// ── helpers ─────────────────────────────────────────────────────────────

function renderSummary(plan, sourceLabel) {
  const exts = Object.entries(plan.byExt)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 12);
  const extRows = exts.map(([ext, info]) =>
    `<li><span class="batch-ext">${escapeHtml(ext)}</span> <span class="batch-count">${info.count}</span> <span class="batch-bytes">${formatBytes(info.bytes)}</span></li>`,
  ).join('');
  return `
    <div class="batch-summary-head">
      <span class="batch-summary-label">${escapeHtml(sourceLabel)}</span>
      <span class="batch-summary-totals">
        ${plan.kept.length} file(s) · ${formatBytes(plan.totalBytes)} · ${plan.skipped.length} skipped
      </span>
    </div>
    <ul class="batch-ext-list">${extRows || '<li class="batch-ext-empty">(no parseable files)</li>'}</ul>
  `;
}

function renderSkipped(skipped) {
  const grouped = new Map();
  for (const s of skipped) {
    const key = s.reason;
    grouped.set(key, (grouped.get(key) || 0) + 1);
  }
  const rows = Array.from(grouped.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `<li><span class="batch-skip-reason">${escapeHtml(reason)}</span> <span class="batch-count">${count}</span></li>`)
    .join('');
  return `<details><summary>Skipped ${skipped.length} file(s)</summary><ul class="batch-skipped-list">${rows}</ul></details>`;
}

function inferFolderName(entries) {
  for (const e of entries) {
    const segs = String(e.relativePath || '').split('/').filter(Boolean);
    if (segs.length > 1) return segs[0];
  }
  return '';
}

function slugify(s) {
  return String(s || 'batch')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'batch';
}

function shortStamp() {
  const d = new Date();
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

function truncateMid(s, n) {
  const str = String(s || '');
  if (str.length <= n) return str;
  const half = Math.floor((n - 1) / 2);
  return `${str.slice(0, half)}…${str.slice(-half)}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

// Re-export so other modules can mention the same skip rules in docs / UI.
export { IGNORED_DIR_SEGMENTS };
