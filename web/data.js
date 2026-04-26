let _ingestSupported = null;

export async function loadGraph() {
  const res = await fetch(`./data/graph.json?ts=${Date.now()}`);
  if (!res.ok) throw new Error(`Failed to load graph (${res.status})`);
  return res.json();
}

/**
 * Returns true if the host has a real ingest server (the local dev server in
 * `scripts/serve.mjs` exposes /api/ingest/*). The static Cloudflare Worker
 * deploy does not — it can't shell out to the user's filesystem.
 */
export async function ingestSupported() {
  if (_ingestSupported !== null) return _ingestSupported;
  try {
    const res = await fetch('/api/ingest/health', { method: 'GET' });
    _ingestSupported = res.ok;
  } catch {
    _ingestSupported = false;
  }
  return _ingestSupported;
}

export async function runIngest(name) {
  const res = await fetch(`/api/ingest/${encodeURIComponent(name)}`, { method: 'POST' });
  let body = {};
  try { body = await res.json(); } catch {}
  return { ok: res.ok, status: res.status, ...body };
}
