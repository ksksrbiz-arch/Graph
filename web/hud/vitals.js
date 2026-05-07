/* Vitals strip — mirrors live counters into the topbar neural-interface chrome.
   Reads from the same DOM nodes other HUDs already keep up to date:
     #stats          → "<n> nodes · <m> edges"
     #hud-fps        → "<n> fps"
     #hud-spikes     → "<n> spikes/s"
   No new data sources, no new event plumbing — just a passive MutationObserver
   so we stay in lockstep with whatever code already updates those fields. */

const NUM_RE = /-?\d[\d,]*\.?\d*/g;

function nums(text) {
  if (!text) return [];
  const m = text.match(NUM_RE);
  return m ? m.map((n) => n.replace(/,/g, '')) : [];
}

function pickFirst(text, fallback = '0') {
  const [a] = nums(text);
  return a ?? fallback;
}

function syncFromStats() {
  const stats = document.getElementById('stats');
  const [n, e] = nums(stats?.textContent || '');
  const elN = document.getElementById('vital-nodes');
  const elE = document.getElementById('vital-edges');
  if (elN) elN.textContent = n ? Number(n).toLocaleString() : '0';
  if (elE) elE.textContent = e ? Number(e).toLocaleString() : '0';
}

function syncFromHud() {
  const fps = pickFirst(document.getElementById('hud-fps')?.textContent, '—');
  const sp  = pickFirst(document.getElementById('hud-spikes')?.textContent, '0');
  const elF = document.getElementById('vital-fps');
  const elS = document.getElementById('vital-spikes');
  if (elF) elF.textContent = fps;
  if (elS) elS.textContent = sp;
}

function watch(id, cb) {
  const el = document.getElementById(id);
  if (!el) return;
  cb();
  const mo = new MutationObserver(cb);
  mo.observe(el, { childList: true, characterData: true, subtree: true });
}

export function mountVitals() {
  if (!document.getElementById('vitals')) return;
  watch('stats', syncFromStats);
  watch('hud-fps', syncFromHud);
  watch('hud-spikes', syncFromHud);
}

if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountVitals, { once: true });
  } else {
    mountVitals();
  }
}
