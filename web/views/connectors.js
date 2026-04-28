import { state, subscribe } from '../state.js';
import { fmtDate, el, showToast } from '../util.js';
import { loadGraph, localIngestSupported, publicIngestAvailable, runIngestWithParams, uploadFileIngest, ingestPublicGraph, scheduleAutoIngest } from '../data.js';
import { setGraph } from '../state.js';
import { openWizard } from './ingest-wizard.js';
import { loadSavedConfig, loadSchedule, saveSchedule, SCHEDULE_OPTIONS } from './connector-config.js';
import {
  parseBookmarks,
  parseEnex,
  parseClaudeExport,
  parseMarkdownFiles,
  buildDailyNote,
  clipUrls,
  parseClaudeCodeSessions,
  ingestZotero,
  ingestGithub,
} from '../ingest-client.js';

/** True when all required text/password/number/date/etc. fields have saved
 *  values, or the connector has no required non-file non-oauth fields. */
function isQuickRunnable(connector, saved) {
  const fields = connector.wizard?.fields || [];
  const required = fields.filter(
    (f) => f.required && f.type !== 'file' && f.type !== 'multifile' && f.type !== 'oauth',
  );
  if (required.length === 0) return true;
  return required.every((f) => (saved[f.envVar] || saved[f.name] || '').trim());
}

/**
 * True when every *required* field is a file/multifile upload (no text input needed at run time).
 * Returns false when there are no required fields at all — those connectors are quick-runnable,
 * not file-only. The two paths are mutually exclusive in buildCard.
 */
function isFileOnly(connector) {
  const fields = connector.wizard?.fields || [];
  const hasAnyRequired = fields.some((f) => f.required);
  if (!hasAnyRequired) return false;
  return fields.every(
    (f) => !f.required || f.type === 'file' || f.type === 'multifile',
  );
}

// ── Connector definitions ─────────────────────────────────────────────────────
// Each connector may have a `wizard.fields` array that drives the wizard UI.
// Field types: 'text' | 'password' | 'number' | 'date' | 'textarea' |
//              'urls-textarea' | 'file' | 'oauth'
// File fields also need `envVar` (env var passed to the ingester) and `accept`.
// All non-file fields also need `envVar`.

const KNOWN_CONNECTORS = [
  {
    id: 'claude_code',
    name: 'Claude Code',
    icon: '🤖',
    description: 'Conversations from ~/.claude/projects (sessions, tool calls, files touched).',
    enabled: true,
    localOnly: false,
    ingestSlug: 'claude-code',
    clientIngest: async ({ fileMap }) => {
      const files = fileMap['_claude_code_files'];
      if (!files || files.length === 0) {
        throw new Error('Select your ~/.claude/projects folder (or any .jsonl session files)');
      }
      return parseClaudeCodeSessions(files);
    },
    wizard: {
      fields: [
        {
          name: '_claude_code_files',
          envVar: 'CLAUDE_CODE_FILES',
          label: 'Claude Code session files (.jsonl)',
          type: 'multifile',
          accept: '.jsonl',
          webkitdirectory: true,
          required: false,
          dropLabel: 'Drop your ~/.claude/projects folder here, or click to pick .jsonl files',
          hint: 'Browser-only mode: drop the projects/ folder (or individual .jsonl session files). Local dev server can ingest from disk automatically.',
        },
      ],
    },
  },
  {
    id: 'git',
    name: 'Git Repositories',
    icon: '🌿',
    description: 'Recent commits, authors, and file changes from local git repos.',
    enabled: true,
    localOnly: true,
    ingestSlug: 'git',
    wizard: {
      fields: [
        {
          name: 'GIT_SCAN_DIRS',
          envVar: 'GIT_SCAN_DIRS',
          label: 'Scan directories',
          type: 'text',
          placeholder: '/home/user/projects:/home/user/work',
          hint: 'Colon-separated list of directories to scan for git repos. Requires the local dev server (the browser cannot read local git history). For cloud-hosted repos, use the GitHub connector instead.',
        },
      ],
    },
  },
  {
    id: 'markdown',
    name: 'Markdown Notes',
    icon: '📝',
    description: 'Notes from an Obsidian vault or any local Markdown directory.',
    enabled: true,
    localOnly: false,
    ingestSlug: 'markdown',
    clientIngest: async ({ fileMap }) => {
      const files = fileMap['_markdown_files'];
      if (!files || files.length === 0) {
        throw new Error('Select a notes folder or one or more .md files');
      }
      return parseMarkdownFiles(files);
    },
    wizard: {
      fields: [
        {
          name: '_markdown_files',
          envVar: 'NOTES_FILES',
          label: 'Markdown files (or vault folder)',
          type: 'multifile',
          accept: '.md',
          webkitdirectory: true,
          required: false,
          dropLabel: 'Drop a notes folder or .md files here, or click to browse',
          hint: 'Browser-only mode: drop your Obsidian vault (or any folder of .md files). Local dev server reads from NOTES_DIR on disk.',
        },
        {
          name: 'NOTES_DIR',
          envVar: 'NOTES_DIR',
          label: 'Notes directory (local server only)',
          type: 'text',
          placeholder: '~/notes',
          hint: 'Used only when running via the local dev server. Leave blank to auto-detect ~/notes, ~/Documents/notes, ~/Obsidian.',
        },
      ],
    },
  },
  {
    id: 'zotero',
    name: 'Zotero',
    icon: '📚',
    description: 'Academic papers, books, and PDFs from your Zotero library. Creates document, person, and tag nodes.',
    enabled: true,
    localOnly: false,
    ingestSlug: 'zotero',
    clientIngest: async ({ env }) => ingestZotero({
      userId: env.ZOTERO_USER_ID,
      apiKey: env.ZOTERO_API_KEY,
      groupId: env.ZOTERO_GROUP_ID || undefined,
      limit: env.ZOTERO_LIMIT ? Number(env.ZOTERO_LIMIT) : 200,
    }),
    wizard: {
      fields: [
        {
          name: 'ZOTERO_USER_ID',
          envVar: 'ZOTERO_USER_ID',
          label: 'Zotero User ID',
          type: 'text',
          required: true,
          placeholder: '1234567',
          hint: 'Find your numeric user ID at zotero.org/settings/keys',
        },
        {
          name: 'ZOTERO_API_KEY',
          envVar: 'ZOTERO_API_KEY',
          label: 'API Key',
          type: 'password',
          required: true,
          placeholder: 'your-api-key',
          hint: 'Create a read-access key at zotero.org/settings/keys',
        },
        {
          name: 'ZOTERO_GROUP_ID',
          envVar: 'ZOTERO_GROUP_ID',
          label: 'Group ID (optional)',
          type: 'text',
          placeholder: 'Leave blank for personal library',
        },
        {
          name: 'ZOTERO_LIMIT',
          envVar: 'ZOTERO_LIMIT',
          label: 'Max items',
          type: 'number',
          default: '200',
          placeholder: '200',
        },
      ],
    },
  },
  {
    id: 'webclip',
    name: 'Web Clipping',
    icon: '🔖',
    description: 'Clip web pages by URL — strips ads/nav, extracts article body, creates bookmark nodes.',
    enabled: true,
    localOnly: false,
    ingestSlug: 'webclip',
    clientIngest: async ({ env }) => {
      const raw = env.WEBCLIP_URLS || '';
      const urls = raw.split(/[\n,]/).map((u) => u.trim()).filter(Boolean);
      const result = await clipUrls(urls);
      if (result.errors?.length && result.nodes.length === 0) {
        throw new Error(
          `All ${result.errors.length} URL(s) failed to fetch — most likely CORS-blocked. ` +
          `Try sites that allow cross-origin reads, or run via the local dev server.`,
        );
      }
      return result;
    },
    wizard: {
      fields: [
        {
          name: 'WEBCLIP_URLS',
          envVar: 'WEBCLIP_URLS',
          label: 'URLs to clip',
          type: 'urls-textarea',
          required: true,
          placeholder: 'https://example.com/article\nhttps://another.com/post',
          hint: 'One URL per line. In browser-only mode, target sites must allow cross-origin reads (CORS); sites that don\'t will be skipped. The local dev server has no CORS limitation.',
        },
      ],
    },
  },
  {
    id: 'evernote',
    name: 'Evernote',
    icon: '🐘',
    description: 'Import notes from an Evernote ENEX export file. Creates note and concept nodes.',
    enabled: true,
    localOnly: false,
    ingestSlug: 'evernote',
    clientIngest: async ({ fileMap }) => {
      const file = fileMap['_enex_file'];
      if (!file) throw new Error('No ENEX file selected');
      const xml = await file.text();
      return parseEnex(xml);
    },
    wizard: {
      fields: [
        {
          name: '_enex_file',
          envVar: 'ENEX_FILE',
          label: 'ENEX export file',
          type: 'file',
          accept: '.enex',
          required: true,
          dropLabel: 'Drop .enex file here or click to browse',
          hint: 'Export from Evernote: File → Export Notes → Export as ENEX.',
        },
      ],
    },
  },
  {
    id: 'daily_note',
    name: 'Daily Notes',
    icon: '📅',
    description: 'Generate a structured daily Markdown note and ingest it immediately.',
    enabled: true,
    localOnly: false,
    ingestSlug: 'daily-note',
    clientIngest: async ({ env }) => buildDailyNote({
      date: env.DAILY_DATE || undefined,
      tags: env.DAILY_TAGS || undefined,
    }),
    wizard: {
      fields: [
        {
          name: 'DAILY_DATE',
          envVar: 'DAILY_DATE',
          label: 'Date',
          type: 'date',
          hint: 'Leave blank for today. Format: YYYY-MM-DD.',
        },
        {
          name: 'DAILY_NOTES_DIR',
          envVar: 'DAILY_NOTES_DIR',
          label: 'Notes directory (local server only)',
          type: 'text',
          placeholder: '~/Documents/notes/daily',
          hint: 'Used only when running via the local dev server (writes the .md file to disk). Browser-only mode emits a graph node directly.',
        },
        {
          name: 'DAILY_TAGS',
          envVar: 'DAILY_TAGS',
          label: 'Tags (comma-separated)',
          type: 'text',
          default: 'daily,journal',
          placeholder: 'daily,journal',
        },
      ],
    },
  },
  {
    id: 'github',
    name: 'GitHub',
    icon: '🐙',
    description: 'Repos, issues, and PRs. Use OAuth (local server) or a personal access token (online).',
    enabled: true,
    localOnly: false,
    ingestSlug: 'github',
    clientIngest: async ({ env }) => ingestGithub({
      token: env.GITHUB_TOKEN,
      login: env.GITHUB_LOGIN || undefined,
      reposLimit: env.GITHUB_REPOS_LIMIT ? Number(env.GITHUB_REPOS_LIMIT) : 50,
      itemsLimit: env.GITHUB_ITEMS_LIMIT ? Number(env.GITHUB_ITEMS_LIMIT) : 30,
    }),
    wizard: {
      fields: [
        {
          name: '_github_oauth',
          type: 'oauth',
          provider: 'github',
          label: 'GitHub account (OAuth)',
          hint: 'Authorize read access via OAuth. Requires the local dev server with GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET.',
        },
        {
          name: 'GITHUB_TOKEN',
          envVar: 'GITHUB_TOKEN',
          label: 'Personal access token (alternative to OAuth)',
          type: 'password',
          placeholder: 'ghp_…',
          hint: 'Use a PAT instead of OAuth — works without the local dev server. Create at github.com/settings/tokens (repo + read:user scopes).',
        },
        {
          name: 'GITHUB_LOGIN',
          envVar: 'GITHUB_LOGIN',
          label: 'GitHub username / org (optional)',
          type: 'text',
          placeholder: 'octocat',
          hint: 'Leave blank to use the authenticated user.',
        },
        {
          name: 'GITHUB_REPOS_LIMIT',
          envVar: 'GITHUB_REPOS_LIMIT',
          label: 'Max repos',
          type: 'number',
          default: '50',
        },
        {
          name: 'GITHUB_ITEMS_LIMIT',
          envVar: 'GITHUB_ITEMS_LIMIT',
          label: 'Max issues+PRs per repo',
          type: 'number',
          default: '30',
        },
      ],
    },
  },
  {
    id: 'bookmarks',
    name: 'Browser Bookmarks',
    icon: '⭐',
    description: 'Import Chrome / Firefox / Safari bookmark exports (Netscape HTML format).',
    enabled: true,
    localOnly: false,
    ingestSlug: 'bookmarks',
    clientIngest: async ({ fileMap }) => {
      const file = fileMap['_bookmarks_file'];
      if (!file) throw new Error('No bookmarks file selected');
      const html = await file.text();
      return parseBookmarks(html);
    },
    wizard: {
      fields: [
        {
          name: '_bookmarks_file',
          envVar: 'BOOKMARKS_FILE',
          label: 'Bookmarks HTML export',
          type: 'file',
          accept: '.html,.htm',
          required: true,
          dropLabel: 'Drop bookmarks.html here or click to browse',
          hint: 'Chrome: Settings → Bookmarks → Export. Firefox: Bookmarks → Manage → Import and Backup → Export.',
        },
      ],
    },
  },
  {
    id: 'claude_export',
    name: 'Claude.ai Export',
    icon: '💬',
    description: 'Import a conversations.json export from Claude.ai. Creates conversation and note nodes.',
    enabled: true,
    localOnly: false,
    ingestSlug: 'claude-export',
    clientIngest: async ({ fileMap }) => {
      const file = fileMap['_claude_export_file'];
      if (!file) throw new Error('No conversations.json file selected');
      const text = await file.text();
      return parseClaudeExport(text);
    },
    wizard: {
      fields: [
        {
          name: '_claude_export_file',
          envVar: 'CLAUDE_EXPORT_FILE',
          label: 'conversations.json',
          type: 'file',
          accept: '.json',
          required: true,
          dropLabel: 'Drop conversations.json here or click to browse',
          hint: 'Download from Claude.ai: Settings → Account → Export Data.',
        },
      ],
    },
  },
];

// ── View init ─────────────────────────────────────────────────────────────────

export function initConnectorsView() {
  subscribe((reason) => {
    if (reason === 'graph-loaded') render();
  });
}

// ── Rendering ─────────────────────────────────────────────────────────────────

async function render() {
  const grid = document.getElementById('connectors-list');
  grid.innerHTML = '';

  const sources = new Map(
    (state.graph.metadata?.sources || []).map((s) => [s.name, s]),
  );

  const [isLocal, isPublic] = await Promise.all([localIngestSupported(), publicIngestAvailable()]);

  for (const c of KNOWN_CONNECTORS) {
    grid.appendChild(buildCard(c, sources.get(c.id), isLocal, isPublic));
    applySchedule(c, isLocal, isPublic);
  }
}

function buildCard(connector, source, isLocal, isPublic) {
  const card = el('div', { class: 'card connector-card', 'data-connector-id': connector.id });

  // Header row
  const cardHead = el('div', { class: 'connector-card-head' });
  cardHead.appendChild(el('span', { class: 'connector-icon', 'aria-hidden': 'true' }, connector.icon || '⚡'));
  const headText = el('div', { class: 'connector-head-text' });
  headText.appendChild(el('h3', {}, connector.name));
  headText.appendChild(el('p', { class: 'meta' }, connector.description));
  cardHead.appendChild(headText);
  card.appendChild(cardHead);

  // Last-run stats
  if (source) {
    const stats = el('div', { class: 'stats' });
    const SKIP_KEYS = new Set(['name', 'lastRunAt']);
    const statEntries = Object.entries(source).filter(
      ([k, v]) => !SKIP_KEYS.has(k) && typeof v === 'number',
    );
    if (statEntries.length > 0) {
      stats.innerHTML = statEntries
        .map(([k, v]) => `<div><div class="num">${v}</div><div class="lbl">${k}</div></div>`)
        .join('');
      card.appendChild(stats);
    }
    card.appendChild(el('div', { class: 'meta connector-last-run' }, `Last run: ${fmtDate(source.lastRunAt)}`));
  } else {
    card.appendChild(el('div', { class: 'meta connector-never-run' }, 'Not yet ingested'));
  }

  // Inline status line (shown during / after inline run)
  const inlineStatus = el('div', { class: 'connector-inline-status' });
  card.appendChild(inlineStatus);

  // Action buttons
  const actions = el('div', { class: 'actions' });
  card.appendChild(actions);

  const hasClientIngest = typeof connector.clientIngest === 'function';
  const canRun = isLocal || (!connector.localOnly && isPublic && hasClientIngest);
  const saved = loadSavedConfig(connector.id);

  if (!canRun) {
    // Unavailable — show disabled button + warning
    const btnRun = el('button', { class: 'primary', type: 'button' }, 'Configure & Run');
    btnRun.disabled = true;
    if (connector.localOnly) {
      btnRun.title = 'Start the local dev server first: npm run start';
      card.appendChild(el('p', { class: 'meta connector-local-warn' }, '⚠ Requires local dev server'));
    } else {
      btnRun.title = 'No ingest API available — start the local dev server or configure an online API';
      card.appendChild(el('p', { class: 'meta connector-local-warn' }, '⚠ Requires local dev server or online API'));
    }
    actions.appendChild(btnRun);
  } else if (isQuickRunnable(connector, saved)) {
    // ── 1-click: ▶ Run directly on the card ─────────────────────────────────
    const btnRun = el('button', { class: 'primary connector-btn-run', type: 'button' }, '▶ Run');
    btnRun.addEventListener('click', () => inlineRun(connector, btnRun, inlineStatus, isLocal, isPublic));
    actions.appendChild(btnRun);

    const btnCfg = el('button', { class: 'connector-btn-cfg', type: 'button', title: 'Open configuration wizard' }, '⚙ Configure');
    btnCfg.addEventListener('click', () => openWizard({ connector }));
    actions.appendChild(btnCfg);

    // Auto-schedule picker (only for non-interactive connectors)
    card.appendChild(buildAutoToggle(connector, isLocal, isPublic));
  } else if (isFileOnly(connector)) {
    // ── 2-click: pick file → run immediately ────────────────────────────────
    const fileField = (connector.wizard?.fields || []).find(
      (f) => f.required && (f.type === 'file' || f.type === 'multifile'),
    );
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.style.display = 'none';
    fileInput.accept = fileField?.accept || '';
    if (fileField?.type === 'multifile') {
      fileInput.multiple = true;
      if (fileField.webkitdirectory) {
        fileInput.setAttribute('webkitdirectory', '');
        fileInput.setAttribute('directory', '');
      }
    }
    card.appendChild(fileInput);

    const btnRun = el('button', { class: 'primary connector-btn-run', type: 'button' }, '📁 Pick & Run');
    btnRun.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      if (!fileInput.files?.length) return;
      const fileMap = {
        [fileField.name]: fileField.type === 'multifile'
          ? Array.from(fileInput.files)
          : fileInput.files[0],
      };
      inlineRunWithFiles(connector, btnRun, inlineStatus, fileMap, isLocal, isPublic);
    });
    actions.appendChild(btnRun);

    const btnCfg = el('button', { class: 'connector-btn-cfg', type: 'button', title: 'Open configuration wizard' }, '⚙ Configure');
    btnCfg.addEventListener('click', () => openWizard({ connector }));
    actions.appendChild(btnCfg);
  } else {
    // ── Needs first-time configuration ───────────────────────────────────────
    const btnRun = el('button', { class: 'primary', type: 'button' }, 'Configure & Run');
    btnRun.addEventListener('click', () => openWizard({ connector }));
    actions.appendChild(btnRun);
  }

  return card;
}

// ── Inline run (no modal, result shown directly on card) ──────────────────────

/** Run a non-file connector inline using saved/default config. */
async function inlineRun(connector, btn, statusEl, isLocal, isPublic) {
  const saved = loadSavedConfig(connector.id);
  const hasClientIngest = typeof connector.clientIngest === 'function';

  btn.disabled = true;
  const origText = btn.textContent;
  btn.textContent = 'Running…';
  statusEl.textContent = '⏳ Running…';
  statusEl.className = 'connector-inline-status connector-inline-running';

  // Build env from saved config + field defaults
  const env = {};
  for (const f of connector.wizard?.fields || []) {
    if (f.type === 'file' || f.type === 'multifile' || f.type === 'oauth') continue;
    const val = (saved[f.envVar] || saved[f.name] || f.default || '').trim();
    if (val && f.envVar) env[f.envVar] = val;
  }

  let res;
  try {
    if (isLocal) {
      res = await runIngestWithParams(connector.ingestSlug, env);
    } else if (!connector.localOnly && isPublic && hasClientIngest) {
      const parsed = await connector.clientIngest({ env, fileMap: {} });
      res = await ingestPublicGraph({
        nodes: parsed.nodes,
        edges: parsed.edges,
        sourceId: parsed.sourceId || connector.id,
      });
    } else {
      res = { ok: false, error: 'Ingest unavailable' };
    }
  } catch (err) {
    res = { ok: false, error: err.message };
  }

  btn.disabled = false;
  btn.textContent = origText;
  applyInlineResult(connector, statusEl, res);
}

/** Run a file-only connector inline after the user picks a file. */
async function inlineRunWithFiles(connector, btn, statusEl, fileMap, isLocal, isPublic) {
  const hasClientIngest = typeof connector.clientIngest === 'function';

  btn.disabled = true;
  const origText = btn.textContent;
  btn.textContent = 'Running…';
  statusEl.textContent = '⏳ Running…';
  statusEl.className = 'connector-inline-status connector-inline-running';

  let res;
  try {
    if (isLocal) {
      const fileField = (connector.wizard?.fields || []).find(
        (f) => f.required && (f.type === 'file' || f.type === 'multifile'),
      );
      if (fileField) {
        const file = Array.isArray(fileMap[fileField.name])
          ? fileMap[fileField.name][0]
          : fileMap[fileField.name];
        res = await uploadFileIngest(connector.ingestSlug, file, fileField.envVar, {});
      } else {
        res = await runIngestWithParams(connector.ingestSlug, {});
      }
    } else if (!connector.localOnly && isPublic && hasClientIngest) {
      const parsed = await connector.clientIngest({ env: {}, fileMap });
      res = await ingestPublicGraph({
        nodes: parsed.nodes,
        edges: parsed.edges,
        sourceId: parsed.sourceId || connector.id,
      });
    } else {
      res = { ok: false, error: 'Ingest unavailable' };
    }
  } catch (err) {
    res = { ok: false, error: err.message };
  }

  btn.disabled = false;
  btn.textContent = origText;
  applyInlineResult(connector, statusEl, res);
}

function applyInlineResult(connector, statusEl, res) {
  if (res.ok) {
    const parts = [
      res.nodes != null && `${res.nodes} nodes`,
      res.edges != null && `${res.edges} edges`,
    ].filter(Boolean);
    statusEl.textContent = `✓ Done${parts.length ? ` — ${parts.join(', ')}` : ''}`;
    statusEl.className = 'connector-inline-status connector-inline-ok';
    showToast(`${connector.name} ingested`, 'success');
    loadGraph().then(setGraph).catch((err) => console.warn('[ingest] graph reload failed', err));
  } else {
    statusEl.textContent = `✗ ${res.error || `Exit ${res.status}`}`;
    statusEl.className = 'connector-inline-status connector-inline-err';
    showToast(`${connector.name} failed`, 'error');
  }
}

// ── Auto-schedule ─────────────────────────────────────────────────────────────

/**
 * Build a small auto-run schedule picker that sits below the action buttons.
 * Only shown on quick-runnable connectors (no user input needed at run time).
 */
function buildAutoToggle(connector, isLocal, isPublic) {
  const sched = loadSchedule(connector.id);
  const currentMs = sched.intervalMs || 0;

  const wrap = el('div', { class: 'connector-auto-wrap' });
  wrap.appendChild(el('span', { class: 'connector-auto-label' }, '⏱ Auto-run:'));

  const sel = el('select', {
    class: `connector-auto-select${currentMs ? ' connector-auto-active' : ''}`,
    title: 'Automatically re-run this connector on a schedule',
    'aria-label': 'Auto-run schedule',
  });

  for (const opt of SCHEDULE_OPTIONS) {
    const o = el('option', { value: String(opt.ms) }, opt.label);
    if (opt.ms === currentMs) o.selected = true;
    sel.appendChild(o);
  }

  sel.addEventListener('change', () => {
    const ms = Number(sel.value);
    const cfg = ms > 0 ? { intervalMs: ms } : {};
    saveSchedule(connector.id, cfg);
    sel.classList.toggle('connector-auto-active', ms > 0);
    applySchedule(connector, isLocal, isPublic);
  });

  wrap.appendChild(sel);
  return wrap;
}

/**
 * Read the saved schedule for a connector and register (or clear) its
 * auto-ingest timer. Safe to call on every render — idempotent.
 */
function applySchedule(connector, isLocal, isPublic) {
  const sched = loadSchedule(connector.id);
  scheduleAutoIngest(connector.id, sched.intervalMs || 0, () => {
    scheduledAutoRun(connector.id, isLocal, isPublic);
  });
}

/**
 * Called by the timer. Finds the live card DOM and runs the connector
 * inline, skipping if a run is already in progress.
 */
function scheduledAutoRun(connectorId, isLocal, isPublic) {
  const card = document.querySelector(`[data-connector-id="${connectorId}"]`);
  if (!card) return;
  const btn = card.querySelector('.connector-btn-run');
  const statusEl = card.querySelector('.connector-inline-status');
  if (!btn || btn.disabled || !statusEl) return;
  const connector = KNOWN_CONNECTORS.find((c) => c.id === connectorId);
  if (!connector) return;
  console.info(`[auto-ingest] Scheduled run: ${connector.name}`);
  inlineRun(connector, btn, statusEl, isLocal, isPublic);
}
