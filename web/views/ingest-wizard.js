/**
 * Ingest Wizard — multi-step modal for configuring and running any data
 * ingestion connector.
 *
 * Usage:
 *   import { openWizard } from './ingest-wizard.js';
 *   openWizard({ connector, onSuccess });
 *
 * `connector` must match the shape defined in connectors.js
 * (id, name, icon, ingestSlug, wizard.fields, …).
 *
 * The wizard walks the user through three steps:
 *   1. Configure — connector-specific form fields.
 *   2. Running   — spinner + live stdout/stderr log.
 *   3. Done      — summary (nodes / edges) and action buttons.
 *
 * All DOM manipulation is vanilla JS; no framework needed.
 */

import {
  runIngestWithParams,
  uploadFileIngest,
  localIngestSupported,
  publicIngestAvailable,
  ingestPublicGraph,
  githubOAuthStatus,
  githubOAuthDisconnect,
  startGitHubOAuth,
  loadGraph,
} from '../data.js';
import { setGraph } from '../state.js';
import { showToast, el } from '../util.js';
import { loadSavedConfig, saveConfig } from './connector-config.js';
import { validateSelectedFiles } from '../ingest-client.js';

const WIZARD_ID = 'ingest-wizard';
const SCRIM_ID  = 'ingest-wizard-scrim';

let _isOpen = false;

// ── Public API ────────────────────────────────────────────────────────────────

export function openWizard({ connector, onSuccess } = {}) {
  if (_isOpen) return;
  _isOpen = true;
  ensureMounted();
  mountWizard(connector, onSuccess);
}

// ── Mount / teardown ──────────────────────────────────────────────────────────

function ensureMounted() {
  if (document.getElementById(WIZARD_ID)) return;

  const scrim = document.createElement('div');
  scrim.id = SCRIM_ID;
  scrim.className = 'wiz-scrim';
  document.body.appendChild(scrim);

  const dlg = document.createElement('div');
  dlg.id = WIZARD_ID;
  dlg.className = 'wiz-dialog';
  dlg.setAttribute('role', 'dialog');
  dlg.setAttribute('aria-modal', 'true');
  document.body.appendChild(dlg);
}

function mountWizard(connector, onSuccess) {
  const scrim = document.getElementById(SCRIM_ID);
  const dlg   = document.getElementById(WIZARD_ID);
  dlg.innerHTML = '';
  scrim.classList.add('wiz-visible');
  dlg.classList.add('wiz-visible');
  dlg.setAttribute('aria-label', `Ingest: ${connector.name}`);

  let step = 'configure'; // 'configure' | 'running' | 'done'
  let result = null;
  const fileMap = {}; // fieldName → File

  // ── Step indicator ───
  const stepBar = el('div', { class: 'wiz-steps' },
    stepDot(1, 'Configure', () => step),
    el('div', { class: 'wiz-step-line' }),
    stepDot(2, 'Running', () => step),
    el('div', { class: 'wiz-step-line' }),
    stepDot(3, 'Done', () => step),
  );

  // ── Header ───
  const header = el('header', { class: 'wiz-header' },
    el('span', { class: 'wiz-icon', 'aria-hidden': 'true' }, connector.icon || '⚡'),
    el('div', { class: 'wiz-header-text' },
      el('h2', {}, connector.name),
      el('p', { class: 'wiz-sub' }, connector.description || ''),
    ),
    closeBtn(),
  );

  // ── Body (swappable per step) ───
  const body = el('div', { class: 'wiz-body' });
  const footer = el('div', { class: 'wiz-footer' });

  dlg.append(stepBar, header, body, footer);

  // ── Keyboard close ───
  function onKey(e) {
    if (e.key === 'Escape' && step !== 'running') closeWizard();
  }
  document.addEventListener('keydown', onKey);

  function closeWizard() {
    if (!_isOpen) return;
    _isOpen = false;
    scrim.classList.remove('wiz-visible');
    dlg.classList.remove('wiz-visible');
    document.removeEventListener('keydown', onKey);
  }

  scrim.onclick = () => { if (step !== 'running') closeWizard(); };

  function closeBtn() {
    const btn = el('button', { class: 'wiz-close', type: 'button', 'aria-label': 'Close' }, '×');
    btn.onclick = () => { if (step !== 'running') closeWizard(); };
    return btn;
  }

  // ── Step 1: Configure ─────────────────────────────────────────────────────

  function renderConfigure() {
    step = 'configure';
    updateStepBar();
    body.innerHTML = '';
    footer.innerHTML = '';

    const fields = connector.wizard?.fields || [];
    const savedValues = loadSavedConfig(connector.id);

    if (!fields.length) {
      body.appendChild(el('p', { class: 'wiz-hint' }, 'No configuration required. Click Run to start.'));
    }

    const form = el('form', { class: 'wiz-form', id: 'wiz-form' });
    form.onsubmit = (e) => { e.preventDefault(); triggerRun(); };

    const oauthFields  = fields.filter((f) => f.type === 'oauth');
    const regularFields = fields.filter((f) => f.type !== 'oauth');

    for (const field of oauthFields) {
      form.appendChild(buildOAuthField(field));
    }

    for (const field of regularFields) {
      form.appendChild(buildField(field, fileMap, savedValues));
    }

    body.appendChild(form);

    // Availability warning — shown only when the connector truly cannot run
    if (connector.localOnly) {
      const hint = el('p', { class: 'wiz-hint wiz-hint-warn' },
        '⚠ This connector requires the local dev server. Run ',
        el('code', {}, 'npm run start'),
        ' first.',
      );
      localIngestSupported().then((ok) => {
        if (!ok) body.appendChild(hint);
      });
    } else if (typeof connector.clientIngest === 'function') {
      // Can run via public API when no local server — show informational hint
      const hint = el('p', { class: 'wiz-hint' },
        'ℹ Runs in the browser — no local dev server needed.',
      );
      Promise.all([localIngestSupported(), publicIngestAvailable()]).then(([loc, pub]) => {
        if (!loc && pub) body.appendChild(hint);
      });
    }

    const btnRun = el('button', { type: 'submit', form: 'wiz-form', class: 'primary wiz-btn-run' }, 'Run Ingest');
    const btnCancel = el('button', { type: 'button', class: 'wiz-btn-cancel' }, 'Cancel');
    btnCancel.onclick = closeWizard;
    footer.append(btnCancel, btnRun);
  }

  // ── Step 2: Running ───────────────────────────────────────────────────────

  function renderRunning(slug) {
    step = 'running';
    updateStepBar();
    body.innerHTML = '';
    footer.innerHTML = '';

    body.appendChild(
      el('div', { class: 'wiz-running' },
        el('div', { class: 'wiz-spinner', 'aria-label': 'Loading' }),
        el('p', { class: 'wiz-running-label' }, `Running ${connector.name}…`),
      ),
    );

    const log = el('div', { class: 'wiz-log', 'aria-live': 'polite' }, 'Starting…\n');
    body.appendChild(log);

    // Show cancel-unavailable hint
    footer.appendChild(el('p', { class: 'wiz-hint' }, 'Ingestion in progress — please wait…'));

    return { log };
  }

  // ── Step 3: Done ──────────────────────────────────────────────────────────

  function renderDone(res) {
    step = 'done';
    updateStepBar();
    body.innerHTML = '';
    footer.innerHTML = '';

    if (res.ok) {
      const statsRow = el('div', { class: 'wiz-stats' });
      if (res.nodes != null) statsRow.appendChild(statBox(res.nodes, 'nodes'));
      if (res.edges != null) statsRow.appendChild(statBox(res.edges, 'edges'));
      body.appendChild(
        el('div', { class: 'wiz-done wiz-done-ok' },
          el('div', { class: 'wiz-done-icon' }, '✓'),
          el('h3', {}, 'Ingest complete'),
          statsRow,
          res.stdout ? el('div', { class: 'wiz-log wiz-log-sm' }, res.stdout.trim()) : null,
        ),
      );
      showToast(`${connector.name} ingested`, 'success');
    } else {
      body.appendChild(
        el('div', { class: 'wiz-done wiz-done-err' },
          el('div', { class: 'wiz-done-icon' }, '✗'),
          el('h3', {}, 'Ingest failed'),
          el('p', { class: 'wiz-err-msg' }, res.error || res.stderr || `Exit code ${res.status}`),
          (res.stdout || res.stderr) ? el('div', { class: 'wiz-log wiz-log-sm' }, (res.stdout || '') + (res.stderr || '')) : null,
        ),
      );
      showToast(`${connector.name} failed`, 'error');
    }

    const btnClose = el('button', { type: 'button', class: 'primary' }, 'Close');
    btnClose.onclick = closeWizard;
    const btnAgain = el('button', { type: 'button' }, 'Run again');
    btnAgain.onclick = renderConfigure;
    footer.append(btnAgain, btnClose);
  }

  // ── Run trigger ───────────────────────────────────────────────────────────

  async function triggerRun() {
    const [isLocal, isPublic] = await Promise.all([localIngestSupported(), publicIngestAvailable()]);
    const hasClientIngest = typeof connector.clientIngest === 'function';

    // Determine run mode
    const useLocal = isLocal;
    const useClient = !isLocal && isPublic && hasClientIngest;

    if (!useLocal && !useClient) {
      showToast(
        connector.localOnly
          ? 'Local dev server not running — start with npm run start'
          : 'Ingest requires the local dev server or a configured online API',
        'error',
      );
      return;
    }

    const fields = connector.wizard?.fields || [];
    const env = {};
    let fileField = null;

    for (const field of fields) {
      if (field.type === 'oauth') continue;
      if (field.type === 'file' || field.type === 'multifile') {
        try {
          validateSelectedFiles(field, fileMap[field.name]);
        } catch (err) {
          showToast(err.message || String(err), 'error');
          return;
        }
        if (fileMap[field.name] && field.type === 'file') {
          fileField = { file: fileMap[field.name], envVar: field.envVar };
        }
        continue;
      }
      const inputEl = document.getElementById(`wiz-field-${field.name}`);
      if (!inputEl) continue;
      const val = inputEl.value.trim();
      if (val) {
        if (field.type === 'urls-textarea') {
          // Comma-join for WEBCLIP_URLS
          env[field.envVar] = val.split('\n').map((u) => u.trim()).filter(Boolean).join(',');
        } else {
          env[field.envVar] = val;
        }
      }
    }

    const { log } = renderRunning(connector.ingestSlug);
    log.textContent = `Running ${connector.ingestSlug}…\n`;

    let res;
    try {
      if (useLocal) {
        // Local dev server path — spawn the Node.js ingester script
        if (fileField) {
          res = await uploadFileIngest(connector.ingestSlug, fileField.file, fileField.envVar, env);
        } else {
          res = await runIngestWithParams(connector.ingestSlug, env);
        }
      } else {
        // Client-side path — parse in browser, POST graph to public API
        log.textContent += 'Parsing in browser (no local server)…\n';
        const parsed = await connector.clientIngest({ env, fileMap });
        log.textContent += `Parsed ${parsed.nodes.length} nodes, ${parsed.edges.length} edges. Sending to API…\n`;
        res = await ingestPublicGraph({
          nodes: parsed.nodes,
          edges: parsed.edges,
          sourceId: parsed.sourceId || connector.id,
        });
      }
    } catch (err) {
      res = { ok: false, error: err.message };
    }

    // Append output to log before transitioning (local server path only)
    const output = [(res.stdout || ''), (res.stderr || '')].filter(Boolean).join('\n');
    if (output) log.textContent += output + '\n';

    result = res;

    // Auto-reload graph on success
    if (res.ok) {
      // Persist field values so the card can offer a 1-click Run next time
      saveConfig(connector.id, env);
      try {
        const fresh = await loadGraph();
        setGraph(fresh);
        if (typeof onSuccess === 'function') onSuccess(res);
      } catch { /* graph reload failure is non-fatal */ }
    }

    renderDone(res);
  }

  // ── Step bar updater ─────────────────────────────────────────────────────

  function updateStepBar() {
    const dots = stepBar.querySelectorAll('.wiz-step-dot');
    const stepOrder = ['configure', 'running', 'done'];
    const idx = stepOrder.indexOf(step);
    dots.forEach((dot, i) => {
      dot.classList.toggle('active', i === idx);
      dot.classList.toggle('done', i < idx);
    });
  }

  // ── Initial render ───────────────────────────────────────────────────────
  renderConfigure();
}

// ── Field builders ────────────────────────────────────────────────────────────

function buildField(field, fileMap, savedValues = {}) {
  const wrap = el('div', { class: 'wiz-field' });
  const labelEl = el('label', { for: `wiz-field-${field.name}`, class: 'wiz-label' },
    field.label,
    field.required ? el('span', { class: 'wiz-required' }, ' *') : null,
  );
  wrap.appendChild(labelEl);

  // Resolve saved value: prefer the envVar key, fall back to field name key
  const savedVal = (savedValues[field.envVar] || savedValues[field.name] || '').trim();

  let input;
  if (field.type === 'textarea' || field.type === 'urls-textarea') {
    input = el('textarea', {
      id: `wiz-field-${field.name}`,
      class: 'wiz-input wiz-textarea',
      rows: '6',
      placeholder: field.placeholder || '',
    });
    input.value = savedVal || field.default || '';
  } else if (field.type === 'file' || field.type === 'multifile') {
    const isMulti = field.type === 'multifile';
    const inputAttrs = {
      id: `wiz-field-${field.name}`,
      type: 'file',
      class: 'wiz-input wiz-file-input',
      accept: field.accept || '',
    };
    if (isMulti) inputAttrs.multiple = '';
    input = el('input', inputAttrs);
    if (isMulti && field.webkitdirectory) {
      input.setAttribute('webkitdirectory', '');
      input.setAttribute('directory', '');
    }
    const defaultDropLabel = field.dropLabel || (isMulti
      ? `Drop ${field.accept || 'files'} here or click to browse`
      : `Drop ${field.accept || 'file'} here or click to browse`);
    const updateSelection = (selectedFiles) => {
      const files = validateSelectedFiles(field, selectedFiles);
      fileMap[field.name] = isMulti ? files : files[0];
      const dz = wrap.querySelector('.wiz-drop-zone span');
      if (dz) dz.textContent = isMulti ? `✓ ${files.length} file(s) selected` : `✓ ${files[0].name}`;
    };
    const clearSelection = () => {
      delete fileMap[field.name];
      input.value = '';
      const dz = wrap.querySelector('.wiz-drop-zone span');
      if (dz) dz.textContent = defaultDropLabel;
    };
    input.addEventListener('change', () => {
      if (!input.files?.length) return;
      try {
        updateSelection(isMulti ? Array.from(input.files) : input.files[0]);
      } catch (err) {
        clearSelection();
        showToast(err.message || String(err), 'error');
      }
    });
    // Drag-and-drop zone
    const dropZone = el('div', { class: 'wiz-drop-zone', 'aria-hidden': 'true' },
      el('span', {}, defaultDropLabel),
    );
    dropZone.addEventListener('click', () => input.click());
    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      const dropped = e.dataTransfer?.files;
      if (!dropped?.length) return;
      try {
        updateSelection(isMulti ? Array.from(dropped) : dropped[0]);
      } catch (err) {
        clearSelection();
        showToast(err.message || String(err), 'error');
      }
    });
    wrap.appendChild(dropZone);
    wrap.appendChild(input);
    if (field.hint) wrap.appendChild(el('p', { class: 'wiz-field-hint' }, field.hint));
    return wrap;
  } else {
    input = el('input', {
      id: `wiz-field-${field.name}`,
      type: field.type || 'text',
      class: 'wiz-input',
      placeholder: field.placeholder || '',
    });
    input.value = savedVal || field.default || '';
  }

  if (field.required) input.setAttribute('required', '');
  wrap.appendChild(input);
  if (field.hint) wrap.appendChild(el('p', { class: 'wiz-field-hint' }, field.hint));
  return wrap;
}

function buildOAuthField(field) {
  const wrap = el('div', { class: 'wiz-field wiz-oauth-field' });

  const statusLine = el('div', { class: 'wiz-oauth-status' });
  const connectBtn = el('button', { type: 'button', class: 'wiz-oauth-btn' });

  async function refreshStatus() {
    const st = await githubOAuthStatus();
    if (st.connected) {
      statusLine.innerHTML = '<span class="wiz-oauth-ok">✓ GitHub connected</span>';
      connectBtn.textContent = 'Disconnect';
      connectBtn.className = 'wiz-oauth-btn wiz-oauth-disconnect';
    } else {
      statusLine.innerHTML = '<span class="wiz-oauth-none">Not connected</span>';
      connectBtn.textContent = 'Connect GitHub';
      connectBtn.className = 'wiz-oauth-btn primary';
    }
  }

  connectBtn.addEventListener('click', async () => {
    const st = await githubOAuthStatus();
    if (st.connected) {
      await githubOAuthDisconnect();
    } else {
      connectBtn.disabled = true;
      connectBtn.textContent = 'Opening…';
      await startGitHubOAuth();
      connectBtn.disabled = false;
    }
    await refreshStatus();
  });

  refreshStatus();

  wrap.appendChild(el('label', { class: 'wiz-label' }, field.label || 'GitHub OAuth'));
  wrap.appendChild(statusLine);
  wrap.appendChild(connectBtn);
  if (field.hint) wrap.appendChild(el('p', { class: 'wiz-field-hint' }, field.hint));
  return wrap;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function stepDot(num, label) {
  const dot = el('div', { class: 'wiz-step-dot' },
    el('span', { class: 'wiz-step-num' }, String(num)),
    el('span', { class: 'wiz-step-label' }, label),
  );
  return dot;
}

function statBox(value, label) {
  return el('div', { class: 'wiz-stat-box' },
    el('div', { class: 'num' }, String(value ?? '—')),
    el('div', { class: 'lbl' }, label),
  );
}
