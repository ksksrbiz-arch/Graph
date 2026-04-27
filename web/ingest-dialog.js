// Modal that lets a visitor paste a text or markdown blob and ship it to the
// public ingest endpoint. The dialog is intentionally lightweight (no
// framework) so it works on the static Cloudflare deploy with the rest of
// the v1 viewer.

import { ingestPublicText } from './data.js';
import { showToast } from './util.js';

const DIALOG_ID = 'ingest-dialog';
const SCRIM_ID = 'ingest-scrim';

let isOpen = false;

export function openIngestDialog({ onSuccess } = {}) {
  if (isOpen) return;
  isOpen = true;
  ensureMounted();

  const dialog = document.getElementById(DIALOG_ID);
  const scrim = document.getElementById(SCRIM_ID);
  const textarea = dialog.querySelector('#ingest-text');
  const titleInput = dialog.querySelector('#ingest-title');
  const formatSelect = dialog.querySelector('#ingest-format');
  const submit = dialog.querySelector('#ingest-submit');
  const cancel = dialog.querySelector('#ingest-cancel');
  const status = dialog.querySelector('#ingest-status');

  textarea.value = '';
  titleInput.value = '';
  formatSelect.value = 'text';
  status.textContent = '';
  status.className = 'ingest-status';

  scrim.classList.remove('hidden');
  dialog.classList.remove('hidden');
  requestAnimationFrame(() => textarea.focus());

  function close() {
    if (!isOpen) return;
    isOpen = false;
    dialog.classList.add('hidden');
    scrim.classList.add('hidden');
    submit.disabled = false;
    document.removeEventListener('keydown', onKey);
  }

  function onKey(e) {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit.click();
  }
  document.addEventListener('keydown', onKey);

  cancel.onclick = close;
  scrim.onclick = close;
  submit.onclick = async () => {
    const text = textarea.value.trim();
    if (text.length < 12) {
      status.textContent = 'Paste at least 12 characters of content.';
      status.className = 'ingest-status warn';
      return;
    }
    submit.disabled = true;
    status.textContent = 'Sending to brain…';
    status.className = 'ingest-status info';

    const result = await ingestPublicText({
      text,
      title: titleInput.value.trim() || undefined,
      format: formatSelect.value === 'markdown' ? 'markdown' : 'text',
    });

    if (result.ok) {
      status.textContent = `Ingested ${result.nodes ?? '?'} nodes / ${result.edges ?? '?'} edges. Brain reload queued: ${result.brainQueuedReload ? 'yes' : 'no'}.`;
      status.className = 'ingest-status ok';
      showToast(`+${result.nodes} nodes ingested`, 'success');
      try { onSuccess?.(result); } catch {}
      setTimeout(close, 900);
    } else {
      status.textContent = `Failed (${result.status || 'network'}): ${result.message || result.error || 'unknown error'}`;
      status.className = 'ingest-status err';
      submit.disabled = false;
    }
  };
}

function ensureMounted() {
  if (document.getElementById(DIALOG_ID)) return;
  const scrim = document.createElement('div');
  scrim.id = SCRIM_ID;
  scrim.className = 'ingest-scrim hidden';
  document.body.appendChild(scrim);

  const dialog = document.createElement('div');
  dialog.id = DIALOG_ID;
  dialog.className = 'ingest-dialog hidden';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-label', 'Ingest text into graph');
  dialog.innerHTML = `
    <header>
      <h2>Live ingest</h2>
      <p class="hint">Paste any notes, markdown, or text. The brain will perceive each new node within seconds.</p>
    </header>
    <label class="row">
      <span>Title (optional)</span>
      <input id="ingest-title" type="text" placeholder="Meeting notes — Apr 27" maxlength="200" />
    </label>
    <label class="row">
      <span>Format</span>
      <select id="ingest-format">
        <option value="text">Plain text (paragraph → note)</option>
        <option value="markdown">Markdown (headings + [[wikilinks]])</option>
      </select>
    </label>
    <textarea id="ingest-text" rows="14" spellcheck="false" placeholder="Paste text here. #hashtags become concept nodes, https://urls become bookmarks, [[wikilinks]] become note → note edges."></textarea>
    <div class="ingest-status" id="ingest-status"></div>
    <footer>
      <button id="ingest-cancel" type="button">Cancel</button>
      <button id="ingest-submit" type="button" class="primary">Ingest (⌘ ⏎)</button>
    </footer>
  `;
  document.body.appendChild(dialog);
}
