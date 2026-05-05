export const TYPE_COLOR = readTypeColors();
export const DEFAULT_COLOR = cssVar('--t-default');

function readTypeColors() {
  return {
    project: cssVar('--t-project'),
    conversation: cssVar('--t-conversation'),
    tool: cssVar('--t-tool'),
    file: cssVar('--t-file'),
    model: cssVar('--t-model'),
    concept: cssVar('--t-concept'),
    repo: cssVar('--t-repo'),
    commit: cssVar('--t-commit'),
    author: cssVar('--t-author'),
    note: cssVar('--t-note'),
    tag: cssVar('--t-tag'),
  };
}

function cssVar(name) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || '#999';
}

export function colorForType(type) {
  return TYPE_COLOR[type] || DEFAULT_COLOR;
}

export function srcId(e) { return typeof e.source === 'object' ? e.source.id : e.source; }
export function tgtId(e) { return typeof e.target === 'object' ? e.target.id : e.target; }

export function escape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

export function truncate(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString();
}

export function fmtDay(s) {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
}

export function fmtTime(s) {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function socketNamespaceUrl(apiBaseUrl, namespace) {
  return `${originFromApiBase(apiBaseUrl)}${namespace}`;
}

function originFromApiBase(apiBaseUrl) {
  try {
    if (typeof apiBaseUrl === 'string' && apiBaseUrl.length > 0) {
      return new URL(apiBaseUrl, window.location.origin).origin;
    }
  } catch {}
  return window.location.origin;
}

/** True when there is plausibly a brain API to talk to. Returns false on the
 *  static MVP hosts (workers.dev / pages.dev / github.io) when no explicit
 *  cross-origin apiBaseUrl is configured — that combination has no API and a
 *  websocket attempt would just produce a noisy DevTools error. */
export function shouldAttemptBrainSocket(apiBaseUrl) {
  if (typeof window === 'undefined') return false;
  try {
    if (typeof apiBaseUrl === 'string' && apiBaseUrl.length > 0) {
      const target = new URL(apiBaseUrl, window.location.origin).origin;
      if (target !== window.location.origin) return true;
    }
  } catch {}
  const h = window.location.hostname || '';
  if (h === 'localhost' || h === '127.0.0.1' || h.endsWith('.local')) return true;
  if (h.endsWith('.workers.dev')) return false;
  if (h.endsWith('.pages.dev')) return false;
  if (h.endsWith('.github.io')) return false;
  return true;
}

export function showToast(msg, kind = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast ${kind}`;
  el.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.add('hidden'), 3500);
}

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'style') { if (typeof v === 'string') node.style.cssText = v; else Object.assign(node.style, v); }
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') node.innerHTML = v;
    else if (v === false) node.removeAttribute(k);
    else if (v != null) node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export function highlightSnippet(text, query) {
  if (!query) return escape(text);
  const re = new RegExp(`(${escapeRegex(query)})`, 'ig');
  return escape(text).replace(re, '<mark>$1</mark>');
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
