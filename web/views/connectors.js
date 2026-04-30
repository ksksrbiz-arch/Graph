import { state, subscribe } from '../state.js';
import { fmtDate, el, showToast } from '../util.js';
import { loadGraph, localIngestSupported, publicIngestAvailable, runIngestWithParams, uploadFileIngest, ingestPublicGraph, scheduleAutoIngest, loadConnectorStatuses, configureConnectorApiKey, triggerConnectorSync, connectOAuthConnector } from '../data.js';
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
  validateSelectedFiles,
} from '../ingest-client.js';

// ── 59-connector catalog ──────────────────────────────────────────────────────
// Mirrors packages/shared/src/connectors.ts (CONNECTOR_CATALOG).

export const CATALOG_CATEGORIES = [
  'AI', 'Communication', 'Calendar', 'Knowledge',
  'Developer Tools', 'Storage', 'CRM & Commerce', 'Media & Social',
];

export const CONNECTOR_CATALOG = [
  // AI
  { id: 'openai',            name: 'OpenAI',            category: 'AI',                description: 'Files and assistants with API-key setup and immediate ingest.',            setupMode: 'apikey', availability: 'available', ctaLabel: 'Add API key' },
  { id: 'anthropic',         name: 'Anthropic',         category: 'AI',                description: 'Model access roster via API key, ready for future activity ingest.',       setupMode: 'apikey', availability: 'available', ctaLabel: 'Add API key' },
  { id: 'perplexity',        name: 'Perplexity',        category: 'AI',                description: 'Research sessions, threads, and saved discoveries.',                       setupMode: 'apikey', availability: 'planned',   ctaLabel: 'Add API key' },
  { id: 'gemini',            name: 'Google Gemini',     category: 'AI',                description: 'Chats, prompts, uploaded files, and workspace context.',                   setupMode: 'oauth',  availability: 'planned',   ctaLabel: 'Connect' },
  { id: 'huggingface',       name: 'Hugging Face',      category: 'AI',                description: 'Models, spaces, datasets, and inference activity.',                        setupMode: 'apikey', availability: 'planned',   ctaLabel: 'Add API key' },
  // Communication
  { id: 'gmail',             name: 'Gmail',             category: 'Communication',     description: 'Mail threads, labels, and attachments.',                                   setupMode: 'oauth',  availability: 'planned',   ctaLabel: 'Connect' },
  { id: 'outlook_mail',      name: 'Outlook Mail',      category: 'Communication',     description: 'Messages, folders, attachments, and threads.',                             setupMode: 'oauth',  availability: 'planned',   ctaLabel: 'Connect' },
  { id: 'slack',             name: 'Slack',             category: 'Communication',     description: 'Channels, DMs, files, and mentions.',                                      setupMode: 'oauth',  availability: 'planned',   ctaLabel: 'Connect' },
  { id: 'discord',           name: 'Discord',           category: 'Communication',     description: 'Servers, channels, messages, and shared links.',                           setupMode: 'oauth',  availability: 'planned',   ctaLabel: 'Connect' },
  { id: 'microsoft_teams',   name: 'Microsoft Teams',   category: 'Communication',     description: 'Teams, chats, meetings, and files.',                                       setupMode: 'oauth',  availability: 'planned',   ctaLabel: 'Connect' },
  { id: 'telegram',          name: 'Telegram',          category: 'Communication',     description: 'Chats, channels, media, and saved messages.',                              setupMode: 'apikey', availability: 'planned',   ctaLabel: 'Add API key' },
  { id: 'whatsapp_business', name: 'WhatsApp Business', category: 'Communication',     description: 'Business conversations and support threads.',                              setupMode: 'apikey', availability: 'planned',   ctaLabel: 'Add API key' },
  { id: 'intercom',          name: 'Intercom',          category: 'Communication',     description: 'Customer conversations, tickets, and contacts.',                           setupMode: 'oauth',  availability: 'planned',   ctaLabel: 'Connect' },
  { id: 'zendesk',           name: 'Zendesk',           category: 'Communication',     description: 'Support tickets, comments, and customer context.',                         setupMode: 'oauth',  availability: 'planned',   ctaLabel: 'Connect' },
  { id: 'help_scout',        name: 'Help Scout',        category: 'Communication',     description: 'Support inboxes, threads, and notes.',                                     setupMode: 'oauth',  availability: 'planned',   ctaLabel: 'Connect' },
  // Calendar
  { id: 'google_calendar',   name: 'Google Calendar',   category: 'Calendar',          description: 'Primary calendar events with attendee edges.',                             setupMode: 'oauth',  availability: 'available', ctaLabel: 'Connect' },
  { id: 'outlook_calendar',  name: 'Outlook Calendar',  category: 'Calendar',          description: 'Meetings, invites, and recurring events.',                                 setupMode: 'oauth',  availability: 'planned',   ctaLabel: 'Connect' },
  { id: 'calendly',          name: 'Calendly',          category: 'Calendar',          description: 'Booking links, events, invitees, and follow-ups.',                         setupMode: 'oauth',  availability: 'planned',   ctaLabel: 'Connect' },
  { id: 'google_tasks',      name: 'Google Tasks',      category: 'Calendar',          description: 'Lists, tasks, due dates, and completion state.',                           setupMode: 'oauth',  availability: 'planned',   ctaLabel: 'Connect' },
  { id: 'todoist',           name: 'Todoist',           category: 'Calendar',          description: 'Projects, tasks, labels, and deadlines.',                                  setupMode: 'oauth',  availability: 'planned',   ctaLabel: 'Connect' },
  // Knowledge
  { id: 'notion',            name: 'Notion',            category: 'Knowledge',         description: 'Pages and parent relationships via one-click OAuth.',                      setupMode: 'oauth',  availability: 'available', ctaLabel: 'Connect' },
  { id: 'obsidian',          name: 'Obsidian',          category: 'Knowledge',         description: 'Vault notes, links, and tags.',                                            setupMode: 'apikey', availability: 'planned',   ctaLabel: 'Add API key' },
  { id: 'roam',              name: 'Roam Research',     category: 'Knowledge',         description: 'Pages, blocks, backlinks, and graph references.',                          setupMode: 'oauth',  availability: 'planned',   ctaLabel: 'Connect' },
  { id: 'evernote',          name: 'Evernote',          category: 'Knowledge',         description: 'Notebooks, notes, tasks, and attachments.',                                setupMode: 'oauth',  availability: 'planned',   ctaLabel: 'Connect' },
  { id: 'confluence',        name: 'Confluence',        category: 'Knowledge',         description: 'Pages, spaces, comments, and mentions.',                                   setupMode: 'oauth',  availability: 'planned',   ctaLabel: 'Connect' },
  { id: 'coda',              name: 'Coda',              category: 'Knowledge',         description: 'Docs, tables, tasks, and collaborative notes.',                            setupMode: 'oauth',  availability: 'planned',   ctaLabel: 'Connect' },
  { id: 'airtable',          name: 'Airtable',          category: 'Knowledge',         description: 'Bases, tables, linked records, and views.',                                setupMode: 'oauth',  availability: 'planned',   ctaLabel: 'Connect' },
  { id: 'zotero',            name: 'Zotero',            category: 'Knowledge',         description: 'Library items, authors, tags, and collections.',                           setupMode: 'apikey', availability: 'available', ctaLabel: 'Add API key' },
  { id: 'web_clip',          name: 'Web clipper',       category: 'Knowledge',         description: 'Captured pages, highlights, and source URLs.',                             setupMode: 'apikey', availability: 'planned',   ctaLabel: 'Add API key' },
  { id: 'bookmarks',         name: 'Bookmarks',         category: 'Knowledge',         description: 'Browser saves, tags, and revisit signals.',                                setupMode: 'apikey', availability: 'planned',   ctaLabel: 'Add API key' },
  // Developer Tools
  { id: 'github',            name: 'GitHub',            category: 'Developer Tools',   description: 'Events, commits, issues, and pull requests.',                              setupMode: 'oauth',  availability: 'available', ctaLabel: 'Connect' },
  { id: 'gitlab',            name: 'GitLab',            category: 'Developer Tools',   description: 'Repos, merge requests, issues, and pipelines.',                            setupMode: 'oauth',  availability: 'planned',   ctaLabel: 'Connect' },
  { id: 'bitbucket',         name: 'Bitbucket',         category: 'Developer Tools',   description: 'Repositories, pull requests, and builds.',                                 setupMode: 'oauth',  availability: 'planned',   ctaLabel: 'Connect' },
  { id: 'linear',            name: 'Linear',            category: 'Developer Tools',   description: 'Issues, projects, cycles, and triage.',                                    setupMode: 'oauth',  availability: 'planned',   ctaLabel: 'Connect' },
  { id: 'jira',              name: 'Jira',              category: 'Developer Tools',   description: 'Issues, epics, sprints, and comments.',                                    setupMode: 'oauth',  availability: 'planned',   ctaLabel: 'Connect' },
  { id: 'asana',             name: 'Asana',             category: 'Developer Tools',   description: 'Projects, tasks, milestones, and comments.',                               setupMode: 'oauth',  availability: 'planned',   ctaLabel: 'Connect' },
  { id: 'trello',            name: 'Trello',            category: 'Developer Tools',   description: 'Boards, lists, cards, and checklists.',                                    setupMode: 'oauth',  availability: 'planned',   ctaLabel: 'Connect' },
  { id: 'clickup',           name: 'ClickUp',           category: 'Developer Tools',   description: 'Spaces, docs, tasks, and goals.',                                          setupMode: 'oauth',  availability: 'planned',   ctaLabel: 'Connect' },
  { id: 'monday',            name: 'Monday.com',        category: 'Developer Tools',   description: 'Boards, items, updates, and timelines.',                                   setupMode: 'oauth',  availability: 'planned',   ctaLabel: 'Connect' },
  { id: 'figma',             name: 'Figma',             category: 'Developer Tools',   description: 'Files, comments, prototypes, and design systems.',                         setupMode: 'oauth',  availability: 'planned',   ctaLabel: 'Connect' },
  { id: 'miro',              name: 'Miro',              category: 'Developer Tools',   description: 'Boards, stickies, diagrams, and brainstorm sessions.',                     setupMode: 'oauth',  availability: 'planned',   ctaLabel: 'Connect' },
  // Storage
  { id: 'google_drive',      name: 'Google Drive',      category: 'Storage',           description: 'Docs, sheets, slides, PDFs, and folder graphs.',                           setupMode: 'oauth',  availability: 'planned',   ctaLabel: 'Connect' },
  { id: 'dropbox',           name: 'Dropbox',           category: 'Storage',           description: 'Files, shared folders, and paper docs.',                                   setupMode: 'oauth',  availability: 'planned',   ctaLabel: 'Connect' },
  { id: 'onedrive',          name: 'OneDrive',          category: 'Storage',           description: 'Files, folders, and collaboration links.',                                 setupMode: 'oauth',  availability: 'planned',   ctaLabel: 'Connect' },
  { id: 'box',               name: 'Box',               category: 'Storage',           description: 'Content, collections, and enterprise documents.',                          setupMode: 'oauth',  availability: 'planned',   ctaLabel: 'Connect' },
  // CRM & Commerce
  { id: 'hubspot',           name: 'HubSpot',           category: 'CRM & Commerce',    description: 'Contacts, companies, deals, and notes.',                                   setupMode: 'oauth',  availability: 'planned',   ctaLabel: 'Connect' },
  { id: 'salesforce',        name: 'Salesforce',        category: 'CRM & Commerce',    description: 'Accounts, opportunities, tasks, and events.',                              setupMode: 'oauth',  availability: 'planned',   ctaLabel: 'Connect' },
  { id: 'pipedrive',         name: 'Pipedrive',         category: 'CRM & Commerce',    description: 'Leads, deals, notes, and follow-up tasks.',                                setupMode: 'oauth',  availability: 'planned',   ctaLabel: 'Connect' },
  { id: 'stripe',            name: 'Stripe',            category: 'CRM & Commerce',    description: 'Customers, subscriptions, invoices, and payments.',                        setupMode: 'apikey', availability: 'planned',   ctaLabel: 'Add API key' },
  { id: 'quickbooks',        name: 'QuickBooks',        category: 'CRM & Commerce',    description: 'Invoices, vendors, customers, and accounting events.',                     setupMode: 'oauth',  availability: 'planned',   ctaLabel: 'Connect' },
  { id: 'shopify',           name: 'Shopify',           category: 'CRM & Commerce',    description: 'Orders, customers, products, and fulfillment.',                            setupMode: 'oauth',  availability: 'planned',   ctaLabel: 'Connect' },
  // Media & Social
  { id: 'x_twitter',         name: 'X / Twitter',       category: 'Media & Social',    description: 'Tweets, replies, bookmarks, and follows.',                                 setupMode: 'oauth',  availability: 'planned',   ctaLabel: 'Connect' },
  { id: 'linkedin',          name: 'LinkedIn',          category: 'Media & Social',    description: 'Posts, messages, contacts, and profile activity.',                         setupMode: 'oauth',  availability: 'planned',   ctaLabel: 'Connect' },
  { id: 'reddit',            name: 'Reddit',            category: 'Media & Social',    description: 'Posts, comments, saves, and subscribed communities.',                      setupMode: 'oauth',  availability: 'planned',   ctaLabel: 'Connect' },
  { id: 'youtube',           name: 'YouTube',           category: 'Media & Social',    description: 'Videos, playlists, watch history, and subscriptions.',                     setupMode: 'oauth',  availability: 'planned',   ctaLabel: 'Connect' },
  { id: 'spotify',           name: 'Spotify',           category: 'Media & Social',    description: 'Saved tracks, playlists, podcasts, and listening patterns.',               setupMode: 'oauth',  availability: 'planned',   ctaLabel: 'Connect' },
  { id: 'pocket',            name: 'Pocket',            category: 'Media & Social',    description: 'Read-later saves, highlights, and tags.',                                  setupMode: 'oauth',  availability: 'planned',   ctaLabel: 'Connect' },
  { id: 'instapaper',        name: 'Instapaper',        category: 'Media & Social',    description: 'Saved articles, highlights, and reading progress.',                        setupMode: 'oauth',  availability: 'planned',   ctaLabel: 'Connect' },
  { id: 'raindrop',          name: 'Raindrop.io',       category: 'Media & Social',    description: 'Bookmarks, collections, annotations, and tags.',                           setupMode: 'oauth',  availability: 'planned',   ctaLabel: 'Connect' },
];

// ── Catalog UI state ──────────────────────────────────────────────────────────

let _catalogQuery = '';
let _catalogCategory = 'All';
let _connectorStatuses = {}; // connectorId → ConnectorSummary
let _catalogBusyId = null;
let _catalogNotice = null; // { type: 'ok'|'err', text: string } | null
let _catalogGrid = null;   // live reference to the grid element for in-place refresh

/** Width / height for OAuth popup windows. */
const OAUTH_POPUP_WIDTH = 560;
const OAUTH_POPUP_HEIGHT = 760;

/** Connector-specific extra metadata prompts, keyed by connector ID. */
const CONNECTOR_METADATA_PROMPTS = {
  zotero: () => {
    const groupId = window.prompt('Optional Zotero group ID (leave blank for personal library)');
    return groupId?.trim() ? { groupId: groupId.trim() } : undefined;
  },
};

/** Return the human-readable name for a connector ID. */
function catalogConnectorName(connectorId) {
  return CONNECTOR_CATALOG.find((c) => c.id === connectorId)?.name ?? connectorId;
}


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

  // Re-render catalog after OAuth popup completes (postMessage from popup)
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (data?.source === 'pkg-oauth') {
      const name = catalogConnectorName(data.connectorId);
      _catalogNotice = { type: 'ok', text: `${name} connected. Sync starting…` };
      reloadCatalogStatuses();
    }
  });
}

// ── Rendering ─────────────────────────────────────────────────────────────────

async function render() {
  const container = document.getElementById('connectors-list');
  container.innerHTML = '';

  const sources = new Map(
    (state.graph.metadata?.sources || []).map((s) => [s.name, s]),
  );

  const [isLocal, isPublic] = await Promise.all([localIngestSupported(), publicIngestAvailable()]);

  // ── Catalog section ──────────────────────────────────────────────────────
  // Render cards immediately (with current, possibly empty, statuses) so the
  // page is never blank while the status network request is in-flight.
  container.appendChild(buildCatalogSection());

  // Capture the catalog grid reference so we can update it in-place once the
  // status data arrives, without re-clearing the whole page.
  const catalogGridSnapshot = _catalogGrid;

  // ── Local ingest tools section ───────────────────────────────────────────
  const inlineWrap = el('div', { class: 'connector-section' });
  inlineWrap.appendChild(
    el('h3', { class: 'connector-section-title' }, 'Local ingest tools'),
  );
  const inlineGrid = el('div', { class: 'card-grid' });
  for (const c of KNOWN_CONNECTORS) {
    inlineGrid.appendChild(buildCard(c, sources.get(c.id), isLocal, isPublic));
    applySchedule(c, isLocal, isPublic);
  }
  inlineWrap.appendChild(inlineGrid);
  container.appendChild(inlineWrap);

  // Load catalog connector statuses (API-backed; returns [] if API unavailable)
  // and refresh the catalog grid in-place with real status badges.
  const statuses = await loadConnectorStatuses();
  // Guard: skip stale update if a newer render() has already replaced the grid.
  if (!catalogGridSnapshot || !catalogGridSnapshot.isConnected) {
    console.debug('[connectors] skipping stale catalog status update');
    return;
  }
  _connectorStatuses = Object.fromEntries(
    (Array.isArray(statuses) ? statuses : []).map((s) => [s.id, s]),
  );
  refreshCatalogGrid();
}

// ── Catalog section ───────────────────────────────────────────────────────────

function buildCatalogSection() {
  const section = el('div', { class: 'connector-section' });

  // Title
  section.appendChild(el('h3', { class: 'connector-section-title' }, 'Connector catalog'));

  // Stats row
  const availableCount = CONNECTOR_CATALOG.filter((c) => c.availability === 'available').length;
  const configuredCount = Object.values(_connectorStatuses).filter((s) => s.configured).length;
  const statsRow = el('div', { class: 'catalog-stats-row' });
  [
    ['Roster', String(CONNECTOR_CATALOG.length)],
    ['Available', String(availableCount)],
    ['Configured', String(configuredCount)],
  ].forEach(([label, value]) => {
    const stat = el('div', { class: 'catalog-stat' });
    stat.appendChild(el('div', { class: 'catalog-stat-value' }, value));
    stat.appendChild(el('div', { class: 'catalog-stat-label' }, label));
    statsRow.appendChild(stat);
  });
  section.appendChild(statsRow);

  // Notice banner (success/error from last action)
  const noticeBanner = el('div', { class: 'catalog-notice', id: 'catalog-notice', hidden: !_catalogNotice });
  if (_catalogNotice) {
    noticeBanner.className = `catalog-notice catalog-notice-${_catalogNotice.type}`;
    noticeBanner.textContent = _catalogNotice.text;
    noticeBanner.hidden = false;
  }
  section.appendChild(noticeBanner);

  // Controls: search + category filter
  const controls = el('div', { class: 'catalog-controls' });

  const searchInput = el('input', {
    type: 'search',
    class: 'catalog-search',
    placeholder: 'Search connectors…',
    'aria-label': 'Search connectors',
    value: _catalogQuery,
  });
  searchInput.addEventListener('input', () => {
    _catalogQuery = searchInput.value;
    refreshCatalogGrid();
  });
  controls.appendChild(searchInput);

  const cats = el('div', { class: 'catalog-categories' });
  for (const cat of ['All', ...CATALOG_CATEGORIES]) {
    const btn = el(
      'button',
      {
        class: `catalog-cat-btn${cat === _catalogCategory ? ' active' : ''}`,
        type: 'button',
        'data-cat': cat,
      },
      cat,
    );
    btn.addEventListener('click', () => {
      _catalogCategory = cat;
      // Update active class
      cats.querySelectorAll('.catalog-cat-btn').forEach((b) =>
        b.classList.toggle('active', b.dataset.cat === cat),
      );
      refreshCatalogGrid();
    });
    cats.appendChild(btn);
  }
  controls.appendChild(cats);
  section.appendChild(controls);

  // Grid
  _catalogGrid = el('div', { class: 'card-grid catalog-grid' });
  refreshCatalogGrid();
  section.appendChild(_catalogGrid);

  return section;
}

function refreshCatalogGrid() {
  if (!_catalogGrid) return;
  _catalogGrid.innerHTML = '';
  const needle = _catalogQuery.trim().toLowerCase();
  const filtered = CONNECTOR_CATALOG.filter((c) => {
    if (_catalogCategory !== 'All' && c.category !== _catalogCategory) return false;
    if (!needle) return true;
    return (
      c.name.toLowerCase().includes(needle) ||
      c.description.toLowerCase().includes(needle) ||
      c.id.toLowerCase().includes(needle)
    );
  });
  for (const c of filtered) {
    _catalogGrid.appendChild(buildCatalogCard(c));
  }
}

function buildCatalogCard(connector) {
  const summary = _connectorStatuses[connector.id];
  const configured = Boolean(summary?.configured);
  const isAvailable = connector.availability === 'available';
  const isBusy = _catalogBusyId === connector.id;

  const card = el('div', {
    class: `card connector-card catalog-card${isAvailable ? '' : ' disabled'}`,
    'data-catalog-id': connector.id,
  });

  // Header
  const head = el('div', { class: 'connector-card-head' });
  const headText = el('div', { class: 'connector-head-text' });
  headText.appendChild(el('h3', {}, connector.name));
  headText.appendChild(el('p', { class: 'meta', style: 'font-size:0.78rem;color:var(--accent);margin:0' }, connector.category));
  head.appendChild(headText);

  // Availability pill (top-right)
  const pill = el(
    'span',
    { class: `catalog-pill ${isAvailable ? 'catalog-pill-available' : 'catalog-pill-planned'}` },
    isAvailable ? 'available' : 'planned',
  );
  head.appendChild(pill);
  card.appendChild(head);

  // Description
  card.appendChild(el('p', { class: 'meta', style: 'margin:0' }, connector.description));

  // Meta pills row
  const metaRow = el('div', { class: 'catalog-card-meta' });
  metaRow.appendChild(
    el('span', { class: 'catalog-pill catalog-pill-mode' }, connector.setupMode === 'oauth' ? 'OAuth' : 'API key'),
  );
  if (configured) {
    metaRow.appendChild(el('span', { class: 'catalog-pill catalog-pill-configured' }, 'configured'));
  }
  if (summary?.lastSyncStatus) {
    metaRow.appendChild(
      el('span', { class: 'catalog-pill catalog-pill-mode' }, `sync: ${summary.lastSyncStatus}`),
    );
  }
  card.appendChild(metaRow);

  // Sync info
  if (configured && summary) {
    const syncInfo = el('div', { class: 'connector-last-run' });
    syncInfo.textContent = `Last sync: ${summary.lastSyncAt ? fmtDate(summary.lastSyncAt) : 'not yet'}`;
    card.appendChild(syncInfo);
  } else if (isAvailable) {
    card.appendChild(el('div', { class: 'connector-never-run' }, 'Ready for one-click setup.'));
  } else {
    card.appendChild(el('div', { class: 'connector-never-run' }, 'Backend ingest not wired yet — visible on the roadmap.'));
  }

  // Inline status
  const inlineStatus = el('div', { class: 'connector-inline-status' });
  card.appendChild(inlineStatus);

  // Actions
  const actions = el('div', { class: 'actions' });

  if (!isAvailable) {
    const btn = el('button', { class: 'primary', type: 'button', disabled: true }, 'Coming soon');
    actions.appendChild(btn);
  } else {
    const primaryLabel = configured ? 'Sync now' : connector.ctaLabel;
    const primaryBtn = el(
      'button',
      { class: 'primary catalog-btn-primary', type: 'button', disabled: isBusy },
      isBusy ? 'Working…' : primaryLabel,
    );
    primaryBtn.addEventListener('click', () =>
      handleCatalogAction(connector, primaryBtn, inlineStatus),
    );
    actions.appendChild(primaryBtn);

    if (configured && connector.setupMode === 'apikey') {
      const updateBtn = el('button', { class: 'connector-btn-cfg', type: 'button', disabled: isBusy }, '🔑 Update key');
      updateBtn.addEventListener('click', () => promptAndConfigureApiKey(connector, primaryBtn, inlineStatus));
      actions.appendChild(updateBtn);
    }
  }

  card.appendChild(actions);
  return card;
}

async function handleCatalogAction(connector, btn, statusEl) {
  const summary = _connectorStatuses[connector.id];
  const configured = Boolean(summary?.configured);

  if (configured) {
    await catalogSync(connector, btn, statusEl);
  } else if (connector.setupMode === 'oauth') {
    await catalogOAuth(connector, btn, statusEl);
  } else {
    await promptAndConfigureApiKey(connector, btn, statusEl);
  }
}

async function catalogSync(connector, btn, statusEl) {
  setCatalogBusy(connector.id, btn, statusEl, '⏳ Syncing…');
  const res = await triggerConnectorSync(connector.id);
  clearCatalogBusy(connector.id, btn);
  if (res.ok) {
    setCatalogNotice('ok', `${connector.name} sync enqueued.`);
    showToast(`${connector.name} sync enqueued`, 'success');
  } else {
    setCatalogNotice('err', `${connector.name}: ${res.error || `HTTP ${res.status}`}`);
    showToast(`${connector.name} sync failed`, 'error');
  }
  reloadCatalogStatuses();
}

async function catalogOAuth(connector, btn, statusEl) {
  setCatalogBusy(connector.id, btn, statusEl, '⏳ Opening…');
  const res = await connectOAuthConnector(connector.id);
  clearCatalogBusy(connector.id, btn);
  if (!res.ok || !res.authorizeUrl) {
    setCatalogNotice('err', `${connector.name}: ${res.error || 'OAuth unavailable'}`);
    showToast(`${connector.name} OAuth failed`, 'error');
    return;
  }
  const popup = window.open(res.authorizeUrl, '_blank', `popup,width=${OAUTH_POPUP_WIDTH},height=${OAUTH_POPUP_HEIGHT}`);
  if (!popup) window.location.assign(res.authorizeUrl);
  setCatalogNotice('ok', `Opening ${connector.name} authorization…`);
}

async function promptAndConfigureApiKey(connector, btn, statusEl) {
  const apiKey = window.prompt(`Paste your ${connector.name} API key`);
  if (!apiKey?.trim()) return;

  let metadata;
  const metaPromptFn = CONNECTOR_METADATA_PROMPTS[connector.id];
  if (metaPromptFn) metadata = metaPromptFn();

  setCatalogBusy(connector.id, btn, statusEl, '⏳ Configuring…');
  const res = await configureConnectorApiKey(connector.id, apiKey.trim(), metadata);
  clearCatalogBusy(connector.id, btn);
  if (res.ok) {
    setCatalogNotice('ok', `${connector.name} configured. Initial ingest starting…`);
    showToast(`${connector.name} configured`, 'success');
  } else {
    setCatalogNotice('err', `${connector.name}: ${res.error || `HTTP ${res.status}`}`);
    showToast(`${connector.name} configuration failed`, 'error');
  }
  reloadCatalogStatuses();
}

function setCatalogBusy(connectorId, btn, statusEl, message) {
  _catalogBusyId = connectorId;
  btn.disabled = true;
  btn.dataset.origText = btn.textContent;
  btn.textContent = 'Working…';
  statusEl.textContent = message;
  statusEl.className = 'connector-inline-status connector-inline-running';
}

function clearCatalogBusy(connectorId, btn) {
  if (_catalogBusyId === connectorId) _catalogBusyId = null;
  btn.disabled = false;
  btn.textContent = btn.dataset.origText || btn.textContent;
}

function setCatalogNotice(type, text) {
  _catalogNotice = { type, text };
  const banner = document.getElementById('catalog-notice');
  if (banner) {
    banner.className = `catalog-notice catalog-notice-${type}`;
    banner.textContent = text;
    banner.hidden = false;
  }
}

async function reloadCatalogStatuses() {
  const statuses = await loadConnectorStatuses();
  _connectorStatuses = Object.fromEntries(
    (Array.isArray(statuses) ? statuses : []).map((s) => [s.id, s]),
  );
  refreshCatalogGrid();
}

// ── Inline connector card (existing local ingest tools) ───────────────────────

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
      try {
        validateSelectedFiles(
          fileField,
          fileField.type === 'multifile' ? Array.from(fileInput.files) : fileInput.files[0],
        );
      } catch (err) {
        fileInput.value = '';
        showToast(err.message || String(err), 'error');
        return;
      }
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
