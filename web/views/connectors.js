import { state, subscribe } from '../state.js';
import { fmtDate, el, showToast } from '../util.js';
import { runIngest, loadGraph, localIngestSupported } from '../data.js';
import { setGraph } from '../state.js';
import { openWizard } from './ingest-wizard.js';

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
    localOnly: true,
    ingestSlug: 'claude-code',
    wizard: { fields: [] }, // no config — just run it
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
          hint: 'Colon-separated list of directories to scan for git repos. Leave blank to use defaults.',
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
    localOnly: true,
    ingestSlug: 'markdown',
    wizard: {
      fields: [
        {
          name: 'NOTES_DIR',
          envVar: 'NOTES_DIR',
          label: 'Notes directory',
          type: 'text',
          placeholder: '~/notes',
          hint: 'Path to your Markdown notes folder. Leave blank to auto-detect ~/notes, ~/Documents/notes, ~/Obsidian.',
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
    localOnly: true,
    ingestSlug: 'zotero',
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
    localOnly: true,
    ingestSlug: 'webclip',
    wizard: {
      fields: [
        {
          name: 'WEBCLIP_URLS',
          envVar: 'WEBCLIP_URLS',
          label: 'URLs to clip',
          type: 'urls-textarea',
          required: true,
          placeholder: 'https://example.com/article\nhttps://another.com/post',
          hint: 'One URL per line. Each page will be fetched and ingested as a bookmark node.',
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
    localOnly: true,
    ingestSlug: 'evernote',
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
    localOnly: true,
    ingestSlug: 'daily-note',
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
          label: 'Notes directory (optional)',
          type: 'text',
          placeholder: '~/Documents/notes/daily',
          hint: 'Where to write the daily note. Leave blank to auto-detect.',
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
    description: 'Repos, issues, and PRs via OAuth. Authorize once and run to keep the graph current.',
    enabled: true,
    localOnly: true,
    ingestSlug: 'github',
    wizard: {
      fields: [
        {
          name: '_github_oauth',
          type: 'oauth',
          provider: 'github',
          label: 'GitHub account',
          hint: 'Authorize read access to your repos, issues, and PRs. Requires GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET on the server.',
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
    localOnly: true,
    ingestSlug: 'bookmarks',
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
    localOnly: true,
    ingestSlug: 'claude-export',
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

  const isLocal = await localIngestSupported();

  for (const c of KNOWN_CONNECTORS) {
    grid.appendChild(buildCard(c, sources.get(c.id), isLocal));
  }
}

function buildCard(connector, source, isLocal) {
  const card = el('div', { class: 'card connector-card' });

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

  // Log output area (shown during run)
  const log = el('div', { class: 'log hidden' });
  card.appendChild(log);

  // Action buttons
  const actions = el('div', { class: 'actions' });

  const btnRun = el('button', { class: 'primary', type: 'button' }, 'Configure & Run');
  btnRun.addEventListener('click', () => {
    openWizard({
      connector,
      onSuccess: async () => {
        try {
          const fresh = await loadGraph();
          setGraph(fresh);
        } catch { /* non-fatal */ }
      },
    });
  });

  // Quick-run button for zero-config connectors (no required fields)
  const hasRequiredFields = (connector.wizard?.fields || []).some(
    (f) => f.required && f.type !== 'oauth',
  );
  if (!hasRequiredFields && connector.wizard?.fields?.length === 0) {
    const btnQuick = el('button', { type: 'button' }, 'Quick Run');
    btnQuick.addEventListener('click', () => quickRun(connector, btnQuick, log));
    actions.appendChild(btnQuick);
  }

  actions.appendChild(btnRun);
  card.appendChild(actions);

  // Local-only indicator
  if (connector.localOnly && !isLocal) {
    btnRun.disabled = true;
    btnRun.title = 'Start the local dev server first: npm run start';
    card.appendChild(el('p', { class: 'meta connector-local-warn' }, '⚠ Requires local dev server'));
  }

  return card;
}

// ── Quick-run (no wizard, no config needed) ───────────────────────────────────

async function quickRun(connector, btn, log) {
  const isLocal = await localIngestSupported();
  if (!isLocal) {
    showToast('Local dev server not running. Start with: npm run start', 'error');
    return;
  }
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = 'Running…';
  log.classList.remove('hidden');
  log.textContent = '';
  try {
    const result = await runIngest(connector.ingestSlug);
    log.textContent = (result.stdout || '') + (result.stderr ? '\n' + result.stderr : '');
    if (result.ok) {
      showToast(`${connector.name} ingest complete`, 'success');
      const fresh = await loadGraph();
      setGraph(fresh);
    } else {
      showToast(`${connector.name} ingest failed (${result.status})`, 'error');
    }
  } catch (err) {
    log.textContent = String(err);
    showToast(`Ingest error: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

