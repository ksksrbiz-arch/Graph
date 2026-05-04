// Docked ingest panel — sits in the top-right of the graph view with four
// tabs:
//   URL        — paste a URL; client fetches + strips tags + posts the
//                cleaned text to /ingest/text. CORS will block many origins;
//                the panel surfaces that error rather than silently failing.
//   Text       — paste text or markdown directly. Auto-detects "looks like
//                markdown" (a heading or [[wikilink]]) and routes accordingly.
//   Connectors — quick-launch cards for every known connector so the user
//                doesn't have to leave the graph view to trigger a sync.
//   Log        — recent ingestion attempts with status + node counts.
//
// Lives alongside the existing modal dialog (web/ingest-dialog.js) — they
// hit the same backend; this is the persistent surface, the modal is the
// quick-one-shot entry point from the topbar.
//
// Activity history is kept in-memory; it doesn't persist across reloads.

import { ingestPublicText, localIngestSupported, publicIngestAvailable, loadGraph } from './data.js';
import { setGraph } from './state.js';
import { showToast } from './util.js';
import { KNOWN_CONNECTORS, executeConnectorIngest } from './views/connectors.js';
import { loadSavedConfig } from './views/connector-config.js';
import { openWizard } from './views/ingest-wizard.js';

const HISTORY_MAX = 50;
const URL_FETCH_BYTE_CAP = 6_000;

export function createIngestPanel({ container, onIngested } = {}) {
  const root = document.createElement('section');
  root.className = 'ingest-panel hidden';
  root.setAttribute('aria-label', 'Live ingest');
  root.innerHTML = `
    <header class="ingest-panel-head">
      <span class="ingest-panel-title">⚡ Brain ingest</span>
      <div class="ingest-panel-tabs" role="tablist">
        <button type="button" data-tab="url" class="active" role="tab">URL</button>
        <button type="button" data-tab="text" role="tab">Text</button>
        <button type="button" data-tab="connectors" role="tab">Connectors</button>
        <button type="button" data-tab="log" role="tab">Log</button>
      </div>
      <button type="button" class="ingest-panel-close" aria-label="Close">✕</button>
    </header>
    <div class="ingest-panel-body">
      <div class="ingest-tab" data-pane="url">
        <div class="ingest-row">
          <input type="url" class="ingest-url" placeholder="https://example.com/article" />
          <button type="button" class="ingest-btn ingest-btn-url">Ingest →</button>
        </div>
        <p class="ingest-hint">Fetched in your browser. Sites without permissive CORS will fall back to "paste the text yourself".</p>
        <div class="ingest-status" data-status></div>
      </div>
      <div class="ingest-tab hidden" data-pane="text">
        <textarea class="ingest-text" rows="6" placeholder="Paste any text, notes, or content. Hashtags + [[wikilinks]] become edges."></textarea>
        <button type="button" class="ingest-btn ingest-btn-text full-width">Add to brain →</button>
        <div class="ingest-status" data-status></div>
      </div>
      <div class="ingest-tab hidden" data-pane="connectors">
        <div class="ingest-connectors" data-connectors></div>
      </div>
      <div class="ingest-tab hidden" data-pane="log">
        <ul class="ingest-log" data-log></ul>
      </div>
    </div>
  `;
  container.appendChild(root);

  const tabs = root.querySelectorAll('.ingest-panel-tabs button');
  const panes = root.querySelectorAll('.ingest-tab');
  const closeBtn = root.querySelector('.ingest-panel-close');
  const urlInput = root.querySelector('.ingest-url');
  const urlBtn = root.querySelector('.ingest-btn-url');
  const urlStatus = root.querySelector('[data-pane="url"] [data-status]');
  const textInput = root.querySelector('.ingest-text');
  const textBtn = root.querySelector('.ingest-btn-text');
  const textStatus = root.querySelector('[data-pane="text"] [data-status]');
  const logEl = root.querySelector('[data-log]');
  const connectorsEl = root.querySelector('[data-connectors]');

  let connectorsRendered = false;

  /** @type {Array<{ source: string, status: 'ok'|'err'|'pending', addedNodes: number, ts: number }>} */
  const history = [];

  function setActiveTab(name) {
    tabs.forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    panes.forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== name));
    if (name === 'connectors' && !connectorsRendered) {
      renderConnectorCards();
      connectorsRendered = true;
    }
  }

  async function renderConnectorCards() {
    connectorsEl.innerHTML = '<div class="ingest-connectors-loading">Loading connectors…</div>';
    const [isLocal, isPublic] = await Promise.all([
      localIngestSupported(),
      publicIngestAvailable(),
    ]);
    connectorsEl.innerHTML = '';
    if (KNOWN_CONNECTORS.length === 0) {
      connectorsEl.innerHTML = '<div class="ingest-connectors-empty">No connectors registered.</div>';
      return;
    }
    for (const connector of KNOWN_CONNECTORS) {
      try {
        connectorsEl.appendChild(buildConnectorCard(connector, isLocal, isPublic));
      } catch (err) {
        console.error(`[ingest-panel] failed to build card for ${connector.id}`, err);
        const fallback = document.createElement('div');
        fallback.className = 'ingest-connector-card ingest-connector-card-error';
        fallback.innerHTML = `<div class="ingest-connector-head">
          <span class="ingest-connector-icon">⚠</span>
          <span class="ingest-connector-name">${escapeHtml(connector.name)}</span>
        </div>
        <div class="ingest-status err">${escapeHtml(String(err?.message || err))}</div>`;
        connectorsEl.appendChild(fallback);
      }
    }
  }

  function buildConnectorCard(connector, isLocal, isPublic) {
    const card = document.createElement('div');
    card.className = 'ingest-connector-card';
    const saved = loadSavedConfig(connector.id);
    const fields = connector.wizard?.fields || [];
    const required = fields.filter((f) => f.required && f.type !== 'oauth');
    const quickRunnable = required
      .filter((f) => f.type !== 'file' && f.type !== 'multifile')
      .every((f) => (saved[f.envVar] || saved[f.name] || '').trim());
    const fileField = fields.find((f) => f.type === 'file' || f.type === 'multifile');
    const hasClientIngest = typeof connector.clientIngest === 'function';
    const canRun = isLocal || (!connector.localOnly && isPublic && hasClientIngest);

    const head = document.createElement('div');
    head.className = 'ingest-connector-head';
    head.innerHTML = `<span class="ingest-connector-icon">${connector.icon || '⚡'}</span>
      <span class="ingest-connector-name">${escapeHtml(connector.name)}</span>`;
    card.appendChild(head);

    const status = document.createElement('div');
    status.className = 'ingest-status';
    card.appendChild(status);

    const actions = document.createElement('div');
    actions.className = 'ingest-connector-actions';
    card.appendChild(actions);

    if (!canRun) {
      const runBtn = document.createElement('button');
      runBtn.type = 'button';
      runBtn.className = 'ingest-btn';
      runBtn.textContent = 'Unavailable';
      runBtn.disabled = true;
      runBtn.title = connector.localOnly
        ? 'Requires the local dev server'
        : 'Requires the local dev server or an online API';
      setStatus(status, runBtn.title, 'warn');
      actions.appendChild(runBtn);
      return card;
    }

    // Browser-only mode (no local server) needs the picker as the primary
    // action because client-side ingesters can't auto-discover a folder.
    const pickerIsPrimary = fileField && (!isLocal || !quickRunnable);

    if (fileField) {
      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.style.display = 'none';
      if (fileField.accept) fileInput.accept = fileField.accept;
      if (fileField.type === 'multifile') {
        fileInput.multiple = true;
        if (fileField.webkitdirectory) {
          fileInput.setAttribute('webkitdirectory', '');
          fileInput.setAttribute('directory', '');
        }
      }
      card.appendChild(fileInput);

      const isFolder = fileField.type === 'multifile' && fileField.webkitdirectory;
      const pickBtn = document.createElement('button');
      pickBtn.type = 'button';
      pickBtn.className = 'ingest-btn';
      pickBtn.textContent = isFolder ? '📁 Folder' : '📁 File';
      pickBtn.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', () => {
        if (!fileInput.files?.length) return;
        const fileMap = {
          [fileField.name]: fileField.type === 'multifile'
            ? Array.from(fileInput.files)
            : fileInput.files[0],
        };
        runConnectorFromPanel(connector, pickBtn, status, isLocal, isPublic, { fileMap });
      });
      actions.appendChild(pickBtn);
    }

    if (quickRunnable) {
      const runBtn = document.createElement('button');
      runBtn.type = 'button';
      runBtn.className = pickerIsPrimary ? 'ingest-btn' : 'ingest-btn primary';
      runBtn.textContent = pickerIsPrimary ? 'Saved cfg' : '▶ Run';
      runBtn.addEventListener('click', () => runConnectorFromPanel(connector, runBtn, status, isLocal, isPublic));
      actions.appendChild(runBtn);
    } else if (!fileField) {
      const cfgPrimary = document.createElement('button');
      cfgPrimary.type = 'button';
      cfgPrimary.className = 'ingest-btn primary';
      cfgPrimary.textContent = 'Configure';
      cfgPrimary.addEventListener('click', () => openWizard({ connector }));
      actions.appendChild(cfgPrimary);
    }

    const cfgBtn = document.createElement('button');
    cfgBtn.type = 'button';
    cfgBtn.className = 'ingest-btn ingest-btn-cfg';
    cfgBtn.textContent = '⚙';
    cfgBtn.title = 'Open configuration wizard';
    cfgBtn.addEventListener('click', () => openWizard({ connector }));
    actions.appendChild(cfgBtn);

    return card;
  }

  async function runConnectorFromPanel(connector, btn, statusEl, isLocal, isPublic, opts = {}) {
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = '…';
    setStatus(statusEl, 'Running…', 'info');
    const env = {};
    for (const f of connector.wizard?.fields || []) {
      if (f.type === 'file' || f.type === 'multifile' || f.type === 'oauth') continue;
      const saved = loadSavedConfig(connector.id);
      const val = (saved[f.envVar] || saved[f.name] || f.default || '').trim();
      if (val && f.envVar) env[f.envVar] = val;
    }
    const res = await executeConnectorIngest(
      connector,
      { env, fileMap: opts.fileMap || {} },
      isLocal,
      isPublic,
    );
    btn.disabled = false;
    btn.textContent = orig;
    if (res.ok) {
      const parts = [
        res.nodes != null && `${res.nodes} nodes`,
        res.edges != null && `${res.edges} edges`,
      ].filter(Boolean);
      setStatus(statusEl, `✓ Done${parts.length ? ` — ${parts.join(', ')}` : ''}`, 'ok');
      pushHistory({ source: connector.name, status: 'ok', addedNodes: res.nodes ?? 0 });
      showToast(`${connector.name} ingested`, 'success');
      try { onIngested?.(res); } catch {}
      loadGraph().then(setGraph).catch((err) => console.warn('[ingest-panel] graph reload failed', err));
    } else {
      setStatus(statusEl, `✗ ${res.error || `Exit ${res.status}`}`, 'err');
      pushHistory({ source: connector.name, status: 'err', addedNodes: 0 });
      showToast(`${connector.name} failed`, 'error');
    }
  }

  tabs.forEach((b) => b.addEventListener('click', () => setActiveTab(b.dataset.tab)));
  closeBtn.addEventListener('click', hide);

  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') urlBtn.click();
  });
  urlBtn.addEventListener('click', async () => {
    const url = urlInput.value.trim();
    if (!url) {
      setStatus(urlStatus, 'Provide a URL.', 'warn');
      return;
    }
    urlBtn.disabled = true;
    setStatus(urlStatus, 'Fetching…', 'info');
    let cleaned;
    try {
      const res = await fetch(url, { mode: 'cors' });
      const html = await res.text();
      cleaned = stripHtml(html).slice(0, URL_FETCH_BYTE_CAP);
      if (cleaned.length < 12) throw new Error('No readable text');
    } catch (e) {
      setStatus(urlStatus, `Couldn't fetch (${e.message || 'CORS blocked'}). Paste the text instead.`, 'err');
      urlBtn.disabled = false;
      return;
    }
    setStatus(urlStatus, 'Sending to brain…', 'info');
    const result = await ingestPublicText({ text: cleaned, title: url, format: 'text' });
    if (result.ok) {
      setStatus(urlStatus, `+${result.nodes ?? 0} nodes / ${result.edges ?? 0} edges`, 'ok');
      pushHistory({ source: url, status: 'ok', addedNodes: result.nodes ?? 0 });
      try { onIngested?.(result); } catch {}
      urlInput.value = '';
    } else {
      setStatus(urlStatus, `Failed (${result.status || 'network'}): ${result.message || result.error || 'unknown'}`, 'err');
      pushHistory({ source: url, status: 'err', addedNodes: 0 });
    }
    urlBtn.disabled = false;
  });

  textBtn.addEventListener('click', async () => {
    const raw = textInput.value.trim();
    if (raw.length < 12) {
      setStatus(textStatus, 'Paste at least 12 characters.', 'warn');
      return;
    }
    textBtn.disabled = true;
    setStatus(textStatus, 'Sending to brain…', 'info');
    const format = looksLikeMarkdown(raw) ? 'markdown' : 'text';
    const result = await ingestPublicText({ text: raw, format });
    if (result.ok) {
      setStatus(textStatus, `+${result.nodes ?? 0} nodes / ${result.edges ?? 0} edges`, 'ok');
      pushHistory({ source: 'pasted text', status: 'ok', addedNodes: result.nodes ?? 0 });
      try { onIngested?.(result); } catch {}
      textInput.value = '';
    } else {
      setStatus(textStatus, `Failed (${result.status || 'network'}): ${result.message || result.error || 'unknown'}`, 'err');
      pushHistory({ source: 'pasted text', status: 'err', addedNodes: 0 });
    }
    textBtn.disabled = false;
  });

  function setStatus(target, message, kind) {
    target.textContent = message;
    target.className = `ingest-status ${kind || ''}`.trim();
  }

  function pushHistory(entry) {
    history.unshift({ ...entry, ts: Date.now() });
    if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
    renderLog();
  }

  function renderLog() {
    if (history.length === 0) {
      logEl.innerHTML = '<li class="ingest-log-empty">No ingestion history yet.</li>';
      return;
    }
    logEl.innerHTML = history.map((entry) => {
      const tone = entry.status === 'ok' ? 'ok' : entry.status === 'err' ? 'err' : 'info';
      const time = new Date(entry.ts).toLocaleTimeString();
      const src = escapeHtml(entry.source).slice(0, 60);
      return `<li class="ingest-log-row ${tone}">
        <span class="src">${src}</span>
        <span class="cnt">+${entry.addedNodes} nodes</span>
        <span class="ts">${time}</span>
      </li>`;
    }).join('');
  }
  renderLog();

  function show() { root.classList.remove('hidden'); }
  function hide() { root.classList.add('hidden'); }
  function toggle() { root.classList.toggle('hidden'); }

  return { show, hide, toggle, root };
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeMarkdown(s) {
  return /(^|\n)#{1,6}\s/.test(s) || /\[\[[^\]]+\]\]/.test(s);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}
