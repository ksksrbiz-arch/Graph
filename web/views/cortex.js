// Cortex chat view — JARVIS-style thought stream rendered as the loop runs.
// POSTs to /api/v1/cortex/{perceive,think}; falls back gracefully when the
// AI binding isn't available (renders the trace anyway).
//
// Dispatched from web/app.js when the route hash is #/cortex.

const API_PERCEIVE = '/api/v1/cortex/perceive';
const API_THINK    = '/api/v1/cortex/think';
const API_STATE    = '/api/v1/cortex/state';

let mounted = false;
let userId  = 'local';
let apiBase = '';
let transcriptEl = null;
let inputEl = null;
let sendBtn = null;
let pulseTimer = null;

// Layer 7 — voice recording state
let mediaRecorder  = null;
let audioChunks    = [];
let micBtn         = null;

export function mount(rootEl, opts = {}) {
  if (mounted) return;
  mounted = true;
  userId  = (opts.userId  ?? window.GRAPH_CONFIG?.brainUserId ?? 'local').toString();
  apiBase = (opts.apiBase ?? window.GRAPH_CONFIG?.apiBaseUrl  ?? '').toString();

  rootEl.innerHTML = `
    <div class="view-header">
      <h2>Cortex</h2>
      <p class="view-sub">Type, paste, drop a URL, or ask a question. The cortex perceives, then reasons over your graph and tools. Watch the brain spike as it thinks.</p>
    </div>
    <div class="cortex-shell">
      <div class="cortex-transcript" id="cortex-transcript" aria-live="polite"></div>
      <form class="cortex-form" id="cortex-form">
        <textarea id="cortex-input" rows="2" placeholder="Ask something, paste a URL, or drop a thought…" autocomplete="off"></textarea>
        <div class="cortex-actions">
          <button type="button" id="cortex-mic"     title="Record voice (Layer 7 — Whisper)">🎙</button>
          <button type="button" id="cortex-vision"  title="Capture image (Layer 8 — LLaVA)">📷</button>
          <input  type="file"   id="cortex-vision-input" accept="image/*" capture="environment" style="display:none" />
          <button type="button" id="cortex-perceive" title="Just record this — no reasoning">Perceive</button>
          <button type="submit"  id="cortex-think" class="primary" title="Perceive + run the ReAct loop">Think →</button>
        </div>
      </form>
    </div>
  `;

  injectStylesOnce();
  transcriptEl = document.getElementById('cortex-transcript');
  inputEl      = document.getElementById('cortex-input');
  sendBtn      = document.getElementById('cortex-think');
  micBtn       = document.getElementById('cortex-mic');
  document.getElementById('cortex-form').addEventListener('submit', onSubmit);
  document.getElementById('cortex-perceive').addEventListener('click', onPerceive);
  micBtn.addEventListener('click', onMicClick);
  document.getElementById('cortex-vision').addEventListener('click', () => {
    document.getElementById('cortex-vision-input').click();
  });
  document.getElementById('cortex-vision-input').addEventListener('change', onVisionFile);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      document.getElementById('cortex-form').requestSubmit();
    }
  });

  hello();
}

async function hello() {
  try {
    const att = await fetch(api(API_STATE) + `?userId=${encodeURIComponent(userId)}`).then((r) => r.json());
    add('system', `connected · attention focus on ${att?.attention?.focus?.length || 0} nodes · last updated ${rel(att?.attention?.lastUpdated)}`);
  } catch {
    add('system', 'cortex offline — POST will retry when you send.');
  }
}

// ── Layer 7: voice input via Whisper ─────────────────────────────────

async function onMicClick() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    return;
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    add('error', `microphone access denied: ${err.message}`);
    return;
  }

  audioChunks = [];
  mediaRecorder = new MediaRecorder(stream);

  mediaRecorder.ondataavailable = (e) => {
    if (e.data?.size > 0) audioChunks.push(e.data);
  };

  mediaRecorder.onstop = async () => {
    // Stop all tracks so the browser releases the mic indicator.
    stream.getTracks().forEach((t) => t.stop());
    micBtn.textContent = '🎙';
    micBtn.title = 'Record voice (Layer 7 — Whisper)';
    micBtn.classList.remove('recording');

    const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
    audioChunks = [];
    if (blob.size === 0) { add('error', 'voice recording was empty'); return; }

    add('system', `recorded ${(blob.size / 1024).toFixed(1)} KB — transcribing…`);

    let audioB64;
    try {
      audioB64 = await blobToBase64(blob);
    } catch (err) {
      replaceLast('error', `encoding failed: ${err.message}`);
      return;
    }

    try {
      const r = await fetch(api(API_PERCEIVE), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'perceive', modality: 'voice',
          source: 'cortex-ui', userId,
          payload: { audio: audioB64 },
        }),
      });
      const out = await r.json();
      if (!r.ok || out.error) throw new Error(out.error || 'HTTP ' + r.status);
      const transcript = out.transcript || '(transcribed)';
      replaceLast('system', `🎙 transcribed · +${out.nodes} nodes — "${truncateText(transcript, 80)}"`);
    } catch (err) {
      replaceLast('error', `voice perceive failed: ${err.message}`);
    }
  };

  mediaRecorder.start();
  micBtn.textContent = '⏹';
  micBtn.title = 'Stop recording';
  micBtn.classList.add('recording');
  add('system', 'recording… click ⏹ to stop');
}

// ── Layer 8: vision input via LLaVA ──────────────────────────────────

async function onVisionFile(ev) {
  const file = ev.target.files?.[0];
  ev.target.value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    add('error', `expected an image file, got ${file.type}`);
    return;
  }
  add('system', `image selected (${(file.size / 1024).toFixed(1)} KB) — captioning…`);

  let imageB64;
  try {
    imageB64 = await blobToBase64(file);
  } catch (err) {
    replaceLast('error', `encoding failed: ${err.message}`);
    return;
  }

  try {
    const r = await fetch(api(API_PERCEIVE), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'perceive', modality: 'vision',
        source: 'cortex-ui', userId,
        payload: { image: imageB64 },
      }),
    });
    const out = await r.json();
    if (!r.ok || out.error) throw new Error(out.error || 'HTTP ' + r.status);
    const caption = out.caption || '(captioned)';
    replaceLast('system', `📷 captioned · +${out.nodes} nodes — "${truncateText(caption, 80)}"`);
  } catch (err) {
    replaceLast('error', `vision perceive failed: ${err.message}`);
  }
}

// ── helpers ───────────────────────────────────────────────────────────

/** Convert a Blob/File to a base64 string (data URI prefix stripped). */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      // Strip "data:<mime>;base64," prefix
      const comma = dataUrl.indexOf(',');
      resolve(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Truncate text to maxLen chars, appending "…" when cut. */
function truncateText(s, maxLen) {
  return s.length <= maxLen ? s : s.slice(0, maxLen) + '…';
}

async function onPerceive(ev) {
  ev.preventDefault();
  const text = (inputEl.value || '').trim();
  if (!text) return;
  inputEl.value = '';
  add('user', text);
  add('system', 'perceiving…');
  try {
    const body = looksLikeUrl(text)
      ? { kind: 'perceive', modality: 'url',  source: 'cortex-ui', userId, payload: { url: text } }
      : { kind: 'perceive', modality: 'text', source: 'cortex-ui', userId, payload: { text, title: deriveTitle(text) } };
    const r = await fetch(api(API_PERCEIVE), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const out = await r.json();
    if (!r.ok || out.error) throw new Error(out.error || 'HTTP ' + r.status);
    replaceLast('system', `perceived · +${out.nodes} nodes / ${out.edges} edges · total ${out.totalNodes}/${out.totalEdges}`);
  } catch (err) {
    replaceLast('error', `perceive failed: ${err.message}`);
  }
}

async function onSubmit(ev) {
  ev.preventDefault();
  const text = (inputEl.value || '').trim();
  if (!text) return;
  inputEl.value = '';
  sendBtn.disabled = true;
  add('user', text);
  // Perceive first so the loop has something fresh in working memory.
  add('system', 'perceiving…');
  try {
    await fetch(api(API_PERCEIVE), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'perceive',
        modality: looksLikeUrl(text) ? 'url' : 'text',
        source: 'cortex-ui', userId,
        payload: looksLikeUrl(text) ? { url: text } : { text, title: deriveTitle(text) },
      }),
    });
    replaceLast('system', 'perceived. thinking…');
  } catch {
    replaceLast('system', 'perceive failed (continuing to think anyway)…');
  }

  startPulse();
  // Tell the graph view to render a thinking ripple while we reason. A
  // periodic tick keeps the wave alive on long thinks (>2.4s).
  window.dispatchEvent(new CustomEvent('cortex-thinking-start', { detail: {} }));
  const thinkTickTimer = setInterval(() => {
    window.dispatchEvent(new CustomEvent('cortex-thinking-tick', { detail: {} }));
  }, 1800);
  try {
    const r = await fetch(api(API_THINK), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'think', userId, question: text, budgetMs: 20_000, budgetSteps: 5 }),
    });
    const out = await r.json();
    stopPulse();
    if (!r.ok || out?.ok === false) {
      add('error', out.error || `HTTP ${r.status}`);
    } else {
      renderTrace(out.trace || []);
      if (out.finalAnswer) add('assistant', String(out.finalAnswer));
      add('system', `model=${out.model} · ${out.elapsedMs}ms · ${out.trace?.length || 0} steps`);
    }
  } catch (err) {
    stopPulse();
    add('error', `think failed: ${err.message}`);
  } finally {
    clearInterval(thinkTickTimer);
    window.dispatchEvent(new CustomEvent('cortex-thinking-end', { detail: {} }));
    sendBtn.disabled = false;
  }
}

function renderTrace(trace) {
  for (const step of trace) {
    if (step.kind === 'thought') {
      add('thought', `[step ${step.step}] ${step.thought || '(parsed empty thought)'}`);
    } else if (step.kind === 'action') {
      add('action', `→ ${step.intent}(${shortJson(step.args)})`);
    } else if (step.kind === 'observation') {
      // 'speak' tool returns audio — render an inline player.
      if (step.intent === 'speak' && step.ok && step.result?.audioBase64) {
        addAudio('observe', '← speak: ok (' + step.result.bytes + ' bytes ' + step.result.voice + ')', step.result);
        continue;
      }
      const head = step.ok ? 'ok' : `err: ${step.error}`;
      add('observe', `← ${step.intent}: ${head} ${step.result ? '· ' + shortJson(step.result) : ''}`);
    } else if (step.kind === 'final') {
      // final is rendered as an assistant message by the caller
    } else if (step.kind === 'budget-exhausted') {
      add('system', `budget reached at ${step.wallMs}ms`);
    } else if (step.kind === 'ai-error') {
      add('error', `AI: ${step.error}`);
    }
  }
}

// ── transcript ────────────────────────────────────────────────────────

let lastClass = null;
let lastEl = null;

function add(kind, text) {
  const div = document.createElement('div');
  div.className = `cortex-msg cortex-${kind}`;
  div.innerHTML = `<span class="cm-tag">${kind}</span><span class="cm-body"></span>`;
  div.querySelector('.cm-body').textContent = text;
  transcriptEl.appendChild(div);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  lastClass = kind; lastEl = div;
}

function addAudio(kind, label, audioObj) {
  const div = document.createElement('div');
  div.className = 'cortex-msg cortex-' + kind;
  div.innerHTML = '<span class="cm-tag">' + kind + '</span><span class="cm-body"></span>';
  div.querySelector('.cm-body').textContent = label;
  const a = document.createElement('audio');
  a.controls = true; a.autoplay = true;
  a.src = 'data:' + (audioObj.mimeType || 'audio/mpeg') + ';base64,' + audioObj.audioBase64;
  div.querySelector('.cm-body').appendChild(document.createElement('br'));
  div.querySelector('.cm-body').appendChild(a);
  transcriptEl.appendChild(div);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  lastClass = kind; lastEl = div;
}

function replaceLast(kind, text) {
  if (!lastEl || lastClass !== kind) return add(kind, text);
  lastEl.querySelector('.cm-body').textContent = text;
}

// ── helpers ───────────────────────────────────────────────────────────

function api(path) {
  if (!apiBase) return path;
  return new URL(path, apiBase).toString();
}

function looksLikeUrl(s) {
  return /^https?:\/\/\S+$/i.test(s.trim());
}
function deriveTitle(s) {
  const first = s.split(/\n/)[0].trim();
  return first.length > 80 ? first.slice(0, 77) + '…' : first;
}
function shortJson(v) {
  try {
    const s = JSON.stringify(v);
    return s.length <= 140 ? s : s.slice(0, 137) + '…';
  } catch { return String(v); }
}
function rel(ms) {
  if (!ms) return 'never';
  const dt = (Date.now() - ms) / 1000;
  if (dt < 60) return `${dt | 0}s ago`;
  if (dt < 3600) return `${(dt/60) | 0}m ago`;
  return `${(dt/3600) | 0}h ago`;
}

function startPulse() {
  let n = 0;
  pulseTimer = setInterval(() => {
    n = (n + 1) % 4;
    document.title = `Graph — Cortex thinking${'.'.repeat(n)}`;
  }, 400);
}
function stopPulse() {
  if (pulseTimer) clearInterval(pulseTimer);
  pulseTimer = null;
  document.title = 'Graph — Personal Knowledge Graph';
}

function injectStylesOnce() {
  if (document.getElementById('cortex-styles')) return;
  const style = document.createElement('style');
  style.id = 'cortex-styles';
  style.textContent = `
    .cortex-shell { display:flex; flex-direction:column; gap:12px; height:100%; padding:0 16px 16px; }
    .cortex-transcript { flex:1; overflow:auto; background:#0a1322; border:1px solid #1d2b44; border-radius:10px; padding:12px; min-height:200px; }
    .cortex-msg { display:flex; gap:10px; align-items:flex-start; padding:6px 0; font:13px/1.45 ui-monospace, "SF Mono", Menlo, monospace; color:#e6eef9; border-bottom:1px dashed #1a2640; }
    .cortex-msg:last-child { border-bottom:none; }
    .cm-tag { display:inline-block; min-width:78px; text-align:right; padding:2px 6px; border-radius:4px; font-size:10.5px; text-transform:uppercase; letter-spacing:0.05em; }
    .cm-body { flex:1; white-space:pre-wrap; word-break:break-word; }
    .cortex-system    .cm-tag { background:#1d2b44; color:#9bd1ff; }
    .cortex-user      .cm-tag { background:#1d3a5e; color:#cfe7ff; }
    .cortex-assistant .cm-tag { background:#1f4d33; color:#a3f7c2; }
    .cortex-thought   .cm-tag { background:#2a2244; color:#cfb1ff; }
    .cortex-action    .cm-tag { background:#3a2d1a; color:#ffd28a; }
    .cortex-observe   .cm-tag { background:#1a2c2c; color:#9ee5d7; }
    .cortex-error     .cm-tag { background:#3a1a1a; color:#ff8a8a; }
    .cortex-form { display:flex; flex-direction:column; gap:8px; }
    .cortex-form textarea { width:100%; resize:vertical; background:#0a1322; color:#e6eef9; border:1px solid #1d2b44; border-radius:8px; padding:10px; font:13px/1.4 system-ui; }
    .cortex-actions { display:flex; gap:8px; justify-content:flex-end; }
    .cortex-actions button { padding:6px 12px; border-radius:6px; border:1px solid #1d2b44; background:#101a2c; color:#e6eef9; cursor:pointer; font:12px/1 system-ui; }
    .cortex-actions button.primary { background:#9bd1ff; color:#0b1320; border-color:#9bd1ff; font-weight:600; }
    .cortex-actions button:disabled { opacity:0.5; cursor:wait; }
    .cortex-actions button.recording { background:#ff3b30; border-color:#ff3b30; color:#fff; animation:cortex-blink 1s step-start infinite; }
    @keyframes cortex-blink { 50% { opacity:0.5; } }
  `;
  document.head.appendChild(style);
}


// Drag-and-drop image support — layered onto Copilot's PR #46 Layer 8 impl.
// Finds the existing hidden input (#cortex-vision-input) and feeds dropped
// files into it via DataTransfer so their existing 'change' handler runs.
function initImageDrop() {
  const shell = document.querySelector('.cortex-shell');
  const input = document.getElementById('cortex-vision-input');
  if (!shell || !input) return;
  ['dragenter', 'dragover'].forEach((ev) =>
    shell.addEventListener(ev, (e) => { e.preventDefault(); shell.classList.add('drag-over'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    shell.addEventListener(ev, (e) => { e.preventDefault(); shell.classList.remove('drag-over'); }));
  shell.addEventListener('drop', (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (!f || !/^image\//.test(f.type)) return;
    // Mirror the file into the existing hidden input + trigger change.
    const dt = new DataTransfer();
    dt.items.add(f);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
// Try to wire after DOM settles. mount() in cortex.js fires once on app boot.
setTimeout(initImageDrop, 50);
