import { state, subscribe } from '../state.js';
import { fmtDate, el, showToast } from '../util.js';
import { runIngest, loadGraph } from '../data.js';
import { setGraph } from '../state.js';

const KNOWN_CONNECTORS = [
  {
    id: 'claude_code',
    name: 'Claude Code',
    description: 'Conversations from ~/.claude/projects (sessions, tool calls, files touched).',
    enabled: true,
    ingestSlug: 'claude-code',
  },
  {
    id: 'claude_export',
    name: 'Claude.ai export',
    description: 'Upload a conversations.json export from Claude.ai. Coming soon.',
    enabled: false,
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Issues, PRs, and commits via OAuth. Phase 2.',
    enabled: false,
  },
  {
    id: 'bookmarks',
    name: 'Browser bookmarks',
    description: 'Import OPML/HTML bookmark export. Phase 2.',
    enabled: false,
  },
];

export function initConnectorsView() {
  subscribe((reason) => {
    if (reason === 'graph-loaded') render();
  });
}

function render() {
  const grid = document.getElementById('connectors-list');
  grid.innerHTML = '';
  const sources = new Map(
    (state.graph.metadata?.sources || []).map((s) => [s.name, s]),
  );
  for (const c of KNOWN_CONNECTORS) {
    grid.appendChild(buildCard(c, sources.get(c.id)));
  }
}

function buildCard(connector, source) {
  const card = el('div', { class: 'card' + (connector.enabled ? '' : ' disabled') });
  card.appendChild(el('h3', {}, connector.name));
  card.appendChild(el('p', { class: 'meta' }, connector.description));
  if (source) {
    const stats = el('div', { class: 'stats' });
    stats.innerHTML = `
      <div><div class="num">${source.projects ?? '—'}</div><div class="lbl">projects</div></div>
      <div><div class="num">${source.sessions ?? '—'}</div><div class="lbl">sessions</div></div>
      <div><div class="num">${source.messages ?? '—'}</div><div class="lbl">messages</div></div>
    `;
    card.appendChild(stats);
    card.appendChild(el('div', { class: 'meta' }, `Last run: ${fmtDate(source.lastRunAt)}`));
  } else if (connector.enabled) {
    card.appendChild(el('div', { class: 'meta' }, 'Not yet ingested. Click Run to populate.'));
  }
  const log = el('div', { class: 'log hidden' });
  card.appendChild(log);

  const actions = el('div', { class: 'actions' });
  if (connector.enabled) {
    const btn = el('button', { class: 'primary', type: 'button' }, 'Run ingest');
    btn.addEventListener('click', () => triggerIngest(connector, btn, log));
    actions.appendChild(btn);
  } else {
    const btn = el('button', { type: 'button', disabled: 'disabled' }, 'Coming soon');
    actions.appendChild(btn);
  }
  card.appendChild(actions);
  return card;
}

async function triggerIngest(connector, btn, log) {
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
