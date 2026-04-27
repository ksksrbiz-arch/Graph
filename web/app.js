import { state, setGraph, setSearch, emit } from './state.js';
import {
  loadGraph,
  runIngest,
  ingestSupported,
  publicIngestAvailable,
  localIngestSupported,
} from './data.js';
import { fmtDate, showToast, escape } from './util.js';
import { openIngestDialog } from './ingest-dialog.js';
import { initGraphView } from './views/graph.js';
import { initTimelineView } from './views/timeline.js';
import { initConnectorsView } from './views/connectors.js';
import { initSearchView } from './views/search.js';
import { initSettingsView } from './views/settings.js';
import { initBrainView } from './views/brain.js';

const ROUTES = ['#/graph', '#/timeline', '#/connectors', '#/brain', '#/search', '#/settings'];

function navigate() {
  let hash = location.hash;
  if (!ROUTES.includes(hash)) hash = '#/graph';
  for (const r of ROUTES) {
    const id = `view-${r.slice(2)}`;
    document.getElementById(id).classList.toggle('active', r === hash);
  }
  document.querySelectorAll('.nav-item').forEach((a) => {
    a.classList.toggle('active', a.dataset.route === hash);
  });
  closeMobileNav();
  closeMobileSearch();
  if (hash === '#/graph') {
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }
}

function openMobileNav() {
  document.body.classList.add('nav-open');
  document.getElementById('nav-toggle')?.setAttribute('aria-expanded', 'true');
  document.getElementById('nav-scrim')?.classList.remove('hidden');
}
function closeMobileNav() {
  document.body.classList.remove('nav-open');
  document.getElementById('nav-toggle')?.setAttribute('aria-expanded', 'false');
  document.getElementById('nav-scrim')?.classList.add('hidden');
}
function toggleMobileSearch() {
  const open = document.body.classList.toggle('search-open');
  if (open) {
    requestAnimationFrame(() => document.getElementById('global-search')?.focus());
  }
}
function closeMobileSearch() {
  document.body.classList.remove('search-open');
}

async function bootstrap() {
  initGraphView();
  initTimelineView();
  initConnectorsView();
  initSearchView();
  initSettingsView();
  initBrainView();

  window.addEventListener('hashchange', navigate);
  navigate();

  document.getElementById('global-search').addEventListener('input', (e) => {
    setSearch(e.target.value);
  });
  document.getElementById('nav-toggle').addEventListener('click', () => {
    if (document.body.classList.contains('nav-open')) closeMobileNav();
    else openMobileNav();
  });
  document.getElementById('nav-scrim').addEventListener('click', closeMobileNav);
  document.getElementById('search-toggle').addEventListener('click', toggleMobileSearch);
  document.getElementById('global-search').addEventListener('blur', () => {
    if (!document.getElementById('global-search').value) closeMobileSearch();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeMobileNav(); closeMobileSearch(); }
  });

  document.getElementById('ingest-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const [hasLocal, hasPublic] = await Promise.all([
      localIngestSupported(),
      publicIngestAvailable(),
    ]);

    // Prefer the local filesystem ingester when running under scripts/serve.mjs
    // — that exercises the production v1 ingestion pipeline end-to-end.
    if (hasLocal) {
      btn.disabled = true;
      const orig = btn.querySelector('.btn-text')?.textContent;
      const txt = btn.querySelector('.btn-text');
      if (txt) txt.textContent = 'Ingesting…';
      try {
        const result = await runIngest('claude-code');
        if (result.ok) {
          showToast('Ingest complete', 'success');
          await refresh();
        } else {
          showToast(`Ingest failed (${result.status})`, 'error');
        }
      } catch (err) {
        showToast(`Ingest error: ${err.message}`, 'error');
      } finally {
        btn.disabled = false;
        if (txt && orig) txt.textContent = orig;
      }
      return;
    }

    if (hasPublic) {
      openIngestDialog({ onSuccess: () => refresh() });
      return;
    }

    showToast('Ingest unavailable — start the local dev server or set GRAPH_CONFIG.apiBaseUrl', 'info');
  });

  await refresh();

  // label-degrade: relabel ingest button on static deploys without a public api
  await relabelIngestButton();
}

async function relabelIngestButton() {
  const btn = document.getElementById('ingest-btn');
  if (!btn) return;
  const txt = btn.querySelector('.btn-text');
  const [hasLocal, hasPublic] = await Promise.all([
    localIngestSupported(),
    publicIngestAvailable(),
  ]);
  if (hasLocal) {
    if (txt) txt.textContent = 'Ingest Claude Code';
    btn.title = 'Run the claude-code ingester via the local dev server';
    return;
  }
  if (hasPublic) {
    if (txt) txt.textContent = 'Live ingest';
    btn.title = 'Paste text or markdown — the brain will perceive new nodes within seconds';
    return;
  }
  if (txt) txt.textContent = 'Ingest (local)';
  btn.title = 'Ingest is local-only. Run: npm run ingest:claude-code (then git push to deploy)';
}

async function refresh() {
  try {
    const data = await loadGraph();
    setGraph(data);
    if (data.metadata?.updatedAt) {
      document.getElementById('sidebar-foot').textContent = `data: ${fmtDate(data.metadata.updatedAt)}`;
    } else {
      document.getElementById('sidebar-foot').textContent = 'no data yet';
    }
    if (data.nodes.length === 0) renderEmpty();
  } catch (err) {
    document.getElementById('stats').textContent = '0 nodes · 0 edges';
    renderEmpty(`Could not load <code>data/graph.json</code> — ${escape(err.message)}`);
  }
}

function renderEmpty(reason) {
  const canvas = document.getElementById('canvas');
  canvas.innerHTML = `
    <div class="empty">
      <div>${reason || 'Graph is empty.'}</div>
      <div>Click <b>Ingest Claude Code</b> in the top bar, or run <code>npm run ingest:claude-code</code>.</div>
    </div>`;
}

bootstrap();
