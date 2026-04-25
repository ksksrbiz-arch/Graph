export async function loadGraph() {
  const res = await fetch(`./data/graph.json?ts=${Date.now()}`);
  if (!res.ok) throw new Error(`Failed to load graph (${res.status})`);
  return res.json();
}

export async function runIngest(name) {
  const res = await fetch(`/api/ingest/${encodeURIComponent(name)}`, { method: 'POST' });
  let body = {};
  try { body = await res.json(); } catch {}
  return { ok: res.ok, status: res.status, ...body };
}
