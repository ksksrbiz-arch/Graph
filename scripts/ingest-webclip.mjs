/**
 * Web clipping ingester (v1).
 *
 * Fetches one or more web pages and ingests them into the knowledge graph as
 * `bookmark` nodes with extracted text content.  Content extraction strips
 * navigation, scripts, ads, and other boilerplate — only the article body or
 * main-content region is retained.
 *
 * Each clipped page produces:
 *  - A `bookmark` node with title, description (first 500 chars of body), and
 *    the source URL.
 *  - `tag` nodes for detected topic keywords (extracted from <meta keywords>).
 *  - `TAGGED_WITH` edges.
 *
 * Configuration (env vars / CLI):
 *   WEBCLIP_URLS   — comma-separated list of URLs to clip.
 *   WEBCLIP_FILE   — path to a plain-text file containing one URL per line.
 *
 * Positional arguments are also accepted:
 *   node scripts/ingest-webclip.mjs https://example.com https://another.com
 *
 * No third-party HTML parser is needed — extraction uses Node's built-in
 * string manipulation; a lightweight regex-based stripper is good enough for
 * producing readable plain-text excerpts.
 *
 * Usage:
 *   node scripts/ingest-webclip.mjs https://example.com/article
 *   WEBCLIP_URLS=https://a.com,https://b.com node scripts/ingest-webclip.mjs
 */

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GraphBuilder, loadGraph, saveGraph, stableId } from './lib/graph-store.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const GRAPH_PATH = join(REPO_ROOT, 'data', 'graph.json');

const SOURCE_ID = 'web_clip';
const FETCH_TIMEOUT_MS = 15_000;
const MAX_BODY_CHARS = 500;

async function resolveUrls() {
  const urls = [];

  // Positional CLI args
  const args = process.argv.slice(2).filter((a) => a.startsWith('http'));
  urls.push(...args);

  // Env: comma-separated
  if (process.env.WEBCLIP_URLS) {
    for (const u of process.env.WEBCLIP_URLS.split(',')) {
      const trimmed = u.trim();
      if (trimmed) urls.push(trimmed);
    }
  }

  // Env: file of URLs
  if (process.env.WEBCLIP_FILE) {
    try {
      const text = await readFile(process.env.WEBCLIP_FILE, 'utf8');
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed && trimmed.startsWith('http')) urls.push(trimmed);
      }
    } catch (err) {
      console.warn(`Could not read WEBCLIP_FILE: ${err.message}`);
    }
  }

  return [...new Set(urls)]; // deduplicate
}

async function fetchPage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'PKG-VS/1.0 WebClip (+https://github.com/ksksrbiz-arch/Graph)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    return html;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Strip HTML tags and collapse whitespace.  Not a full HTML parser, but
 * sufficient for extracting readable plain text from article bodies.
 */
function stripHtml(html) {
  return html
    // Remove <script> and <style> blocks entirely (including whitespace in end tags)
    .replace(/<script[\s\S]*?<\/\s*script\s*>/gi, ' ')
    .replace(/<style[\s\S]*?<\/\s*style\s*>/gi, ' ')
    // Remove HTML comments
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // Remove remaining tags
    .replace(/<[^>]+>/g, ' ')
    // Collapse whitespace before decoding entities to avoid reintroducing tags
    .replace(/\s+/g, ' ')
    .trim()
    // Decode common HTML entities last so decoded '<'/'>' chars are not re-processed
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&'); // &amp; must be decoded last to avoid double-decode
}

function extractMeta(html, name) {
  const re = new RegExp(
    `<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']+)["']`,
    'i',
  );
  const m = re.exec(html) ||
    new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]*(?:name|property)=["']${name}["']`,
      'i',
    ).exec(html);
  return m ? m[1].trim() : null;
}

function extractTitle(html) {
  const ogTitle = extractMeta(html, 'og:title');
  if (ogTitle) return ogTitle;
  const m = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
  return m ? m[1].trim() : null;
}

function extractDescription(html) {
  return (
    extractMeta(html, 'og:description') ||
    extractMeta(html, 'description') ||
    null
  );
}

function extractKeywords(html) {
  const raw = extractMeta(html, 'keywords');
  if (!raw) return [];
  return raw
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k.length > 0 && k.length < 40);
}

/**
 * Attempt to isolate the article body by finding the largest contiguous
 * text block in <article>, <main>, or the longest <p> sequence.
 */
function extractBodyText(html) {
  // Prefer <article> or <main>
  const articleMatch =
    /<article[\s\S]*?>([\s\S]*?)<\/article>/i.exec(html) ||
    /<main[\s\S]*?>([\s\S]*?)<\/main>/i.exec(html);
  if (articleMatch) return stripHtml(articleMatch[1]);

  // Fall back to all paragraph text
  const paragraphs = [];
  const pRe = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = pRe.exec(html)) !== null) {
    const text = stripHtml(m[1]);
    if (text.length > 50) paragraphs.push(text);
  }
  if (paragraphs.length > 0) return paragraphs.join(' ');

  // Last resort: strip everything
  return stripHtml(html);
}

async function clipUrl(url) {
  let html;
  try {
    html = await fetchPage(url);
  } catch (err) {
    console.warn(`  Skipping ${url}: ${err.message}`);
    return null;
  }

  const title = extractTitle(html) || new URL(url).hostname;
  const description = extractDescription(html);
  const keywords = extractKeywords(html);
  const bodyText = extractBodyText(html);
  const excerpt = (description || bodyText).slice(0, MAX_BODY_CHARS);

  return { url, title, excerpt, keywords, bodyText };
}

async function main() {
  const urls = await resolveUrls();
  if (urls.length === 0) {
    console.error(
      'No URLs provided.\n' +
      'Usage: node scripts/ingest-webclip.mjs <url> [url...]\n' +
      '  or set WEBCLIP_URLS=https://... or WEBCLIP_FILE=/path/to/urls.txt',
    );
    process.exit(1);
  }

  console.log(`Clipping ${urls.length} URL(s)...`);

  const existing = await loadGraph(GRAPH_PATH);
  const builder = new GraphBuilder(existing);

  let clipped = 0;
  let tagsCreated = new Set();

  for (const url of urls) {
    console.log(`  Fetching ${url}`);
    const clip = await clipUrl(url);
    if (!clip) continue;

    const nodeId = stableId(SOURCE_ID, url);
    builder.upsertNode({
      id: nodeId,
      label: clip.title.slice(0, 200),
      type: 'bookmark',
      sourceId: SOURCE_ID,
      sourceUrl: url,
      createdAt: new Date().toISOString(),
      metadata: {
        url,
        excerpt: clip.excerpt,
        keywords: clip.keywords,
      },
    });
    clipped += 1;

    for (const keyword of clip.keywords) {
      const tagId = stableId('tag', keyword);
      builder.upsertNode({
        id: tagId,
        label: `#${keyword}`,
        type: 'tag',
        sourceId: SOURCE_ID,
        metadata: { tag: keyword },
      });
      builder.upsertEdge({
        source: nodeId,
        target: tagId,
        relation: 'TAGGED_WITH',
        weight: 0.4,
      });
      tagsCreated.add(keyword);
    }
  }

  builder.recordSource(SOURCE_ID, {
    clipped,
    tags: tagsCreated.size,
  });

  await saveGraph(GRAPH_PATH, builder.graph);

  console.log(`Clipped ${clipped} page(s) · ${tagsCreated.size} keyword tag(s).`);
  console.log(`Graph: ${builder.graph.nodes.length} nodes · ${builder.graph.edges.length} edges`);
  console.log(`Wrote ${GRAPH_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
