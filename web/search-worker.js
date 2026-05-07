self.onmessage = (event) => {
  const { nodes = [], query = '' } = event.data || {};
  try {
    const ql = String(query).trim().toLowerCase();
    if (!ql) {
      self.postMessage({ query, results: [] });
      return;
    }
    const results = [];
    for (const node of nodes) {
      const matches = scoreNode(node, ql);
      if (matches.score > 0) results.push({ node, ...matches });
    }
    results.sort((a, b) => b.score - a.score);
    self.postMessage({ query, results: results.slice(0, 200) });
  } catch (err) {
    self.postMessage({ query, error: err?.message || String(err), results: [] });
  }
};

function scoreNode(node, ql) {
  const fields = [];
  let score = 0;
  const push = (field, value, weight) => {
    if (value == null) return;
    const s = String(value);
    if (s.toLowerCase().includes(ql)) {
      fields.push({ field, value: s });
      score += weight;
    }
  };
  push('label', node.label, 5);
  push('type', node.type, 1);
  push('id', node.id, 0.5);
  for (const [k, v] of Object.entries(node.metadata || {})) {
    if (typeof v === 'object') continue;
    push(k, v, 1);
  }
  return { score, fields };
}
