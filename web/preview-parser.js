/**
 * Lightweight client-side preview parser for web ingest.
 *
 * Purpose: Give users a fast, accurate preview of what nodes/edges would be
 * created from pasted text, markdown, or fetched web content — without
 * actually ingesting anything.
 *
 * This is intentionally simpler than the full server parsers (no stable IDs,
 * no persistence, no brain perception). It focuses on:
 *   - Good sample output for the UI
 *   - Reasonable node/edge count estimates
 *   - Support for the richer extraction we added (headings hierarchy, lists, images, etc.)
 */

export function parseForPreview(content, options = {}) {
  const { format = 'text', title = 'Untitled' } = options;
  const isMarkdown = format === 'markdown' || looksLikeMarkdown(content);

  const nodes = [];
  const edges = [];
  const samples = [];

  const docId = 'preview_doc';
  nodes.push({
    id: docId,
    label: title || 'Web Content',
    type: 'document',
    metadata: { format: isMarkdown ? 'markdown' : 'text' },
  });
  samples.push({ type: 'document', label: title || 'Web Content' });

  if (isMarkdown) {
    parseMarkdownPreview(content, docId, nodes, edges, samples);
  } else {
    parseTextPreview(content, docId, nodes, edges, samples);
  }

  // Deduplicate samples for display (keep first occurrence)
  const seenLabels = new Set();
  const uniqueSamples = samples.filter(s => {
    const key = `${s.type}:${s.label}`;
    if (seenLabels.has(key)) return false;
    seenLabels.add(key);
    return true;
  });

  return {
    nodes: nodes.length,
    edges: edges.length,
    samples: uniqueSamples.slice(0, 16), // UI-friendly limit
    estimatedNodes: nodes.length,
    estimatedEdges: edges.length,
  };
}

function parseTextPreview(text, parentId, nodes, edges, samples) {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(p => p.length > 20)
    .slice(0, 30);

  paragraphs.forEach((p, i) => {
    const label = truncate(p.replace(/\s+/g, ' '), 80);
    const id = `preview_note_${i}`;
    nodes.push({ id, label, type: 'note', metadata: { excerpt: label } });
    edges.push({ source: parentId, target: id, relation: 'PART_OF' });

    if (samples.length < 12) {
      samples.push({ type: 'note', label });
    }

    // Quick extractions
    extractSimpleTags(p, id, nodes, edges, samples);
    extractSimpleWikilinks(p, id, nodes, edges, samples);
  });
}

function parseMarkdownPreview(md, parentId, nodes, edges, samples) {
  const sections = splitMarkdownSections(md).slice(0, 25);
  const headingStack = [];

  sections.forEach((section, i) => {
    const label = truncate(section.title || section.body.slice(0, 70) || '(section)', 80);
    const id = `preview_section_${i}`;

    nodes.push({
      id,
      label,
      type: 'note',
      metadata: { heading: section.title, level: section.level },
    });
    edges.push({ source: parentId, target: id, relation: 'PART_OF' });

    // Heading hierarchy
    while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= section.level) {
      headingStack.pop();
    }
    if (headingStack.length > 0) {
      edges.push({
        source: headingStack[headingStack.length - 1].id,
        target: id,
        relation: 'HAS_CHILD',
      });
    }
    headingStack.push({ level: section.level, id });

    if (samples.length < 12) {
      samples.push({ type: 'note', label: section.title || label });
    }

    const body = section.body || '';

    extractSimpleTags(body, id, nodes, edges, samples);
    extractSimpleWikilinks(body, id, nodes, edges, samples);
    extractSimpleImages(body, id, nodes, edges, samples);
    extractSimpleCode(body, id, nodes, edges, samples);
    extractSimpleLists(body, id, nodes, edges, samples);
  });
}

// --- Lightweight helpers (client-only, good enough for preview) ---

function extractSimpleTags(text, parentId, nodes, edges, samples) {
  const tags = [...new Set(text.match(/#([A-Za-z][\w-]{1,30})/g) || [])]
    .map(t => t.slice(1))
    .slice(0, 6);

  tags.forEach(tag => {
    const id = `preview_tag_${tag}`;
    if (!nodes.find(n => n.id === id)) {
      nodes.push({ id, label: `#${tag}`, type: 'concept', metadata: { tag } });
      edges.push({ source: parentId, target: id, relation: 'TAGGED_WITH' });
      if (samples.length < 12) samples.push({ type: 'concept', label: `#${tag}` });
    }
  });
}

function extractSimpleWikilinks(text, parentId, nodes, edges, samples) {
  const wikis = [...new Set(text.match(/\[\[([^\]|#]+)(?:#|\|)?/g) || [])]
    .map(w => w.replace(/[\[\]|#]/g, '').trim())
    .filter(Boolean)
    .slice(0, 6);

  wikis.forEach(target => {
    const id = `preview_wiki_${target}`;
    if (!nodes.find(n => n.id === id)) {
      nodes.push({ id, label: `[[${target}]]`, type: 'note', metadata: { wikilink: true } });
      edges.push({ source: parentId, target: id, relation: 'LINKS_TO' });
      if (samples.length < 12) samples.push({ type: 'note', label: `[[${target}]]` });
    }
  });
}

function extractSimpleImages(text, parentId, nodes, edges, samples) {
  const imgs = [...text.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)].slice(0, 4);
  imgs.forEach((m, i) => {
    const alt = m[1] || 'image';
    const url = m[2];
    const id = `preview_img_${i}`;
    nodes.push({ id, label: alt, type: 'image', metadata: { url, alt } });
    edges.push({ source: parentId, target: id, relation: 'REFERENCES' });
    if (samples.length < 12) samples.push({ type: 'image', label: alt });
  });
}

function extractSimpleCode(text, parentId, nodes, edges, samples) {
  const blocks = [...text.matchAll(/```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g)].slice(0, 3);
  blocks.forEach((m, i) => {
    const lang = m[1] || 'code';
    const id = `preview_code_${i}`;
    nodes.push({ id, label: `${lang} block`, type: 'code', metadata: { language: lang } });
    edges.push({ source: parentId, target: id, relation: 'PART_OF' });
    if (samples.length < 12) samples.push({ type: 'code', label: `${lang} block` });
  });
}

function extractSimpleLists(text, parentId, nodes, edges, samples) {
  const items = [...text.matchAll(/^\s*([-*+]\s+|\d+\.\s+)(.+)$/gm)].slice(0, 8);
  items.forEach((m, i) => {
    const itemText = m[2].trim();
    if (itemText.length < 6) return;
    const id = `preview_list_${i}`;
    nodes.push({ id, label: truncate(itemText, 70), type: 'list_item', metadata: { list: true } });
    edges.push({ source: parentId, target: id, relation: 'HAS_ITEM' });
    if (samples.length < 12) samples.push({ type: 'list_item', label: truncate(itemText, 50) });
  });
}

// --- Utilities ---

function looksLikeMarkdown(s) {
  return /(^|\n)#{1,6}\s/.test(s) || /\[\[[^\]]+\]\]/.test(s);
}

function splitMarkdownSections(md) {
  const lines = md.split(/\r?\n/);
  const sections = [];
  let current = { level: 0, title: '', body: '' };

  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (m) {
      if (current.title || current.body.trim()) sections.push(current);
      current = { level: m[1].length, title: m[2].trim(), body: '' };
    } else {
      current.body += line + '\n';
    }
  }
  if (current.title || current.body.trim()) sections.push(current);
  return sections;
}

function truncate(s, n) {
  if (!s) return '';
  s = s.replace(/\s+/g, ' ').trim();
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
