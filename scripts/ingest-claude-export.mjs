/**
 * Claude.ai export ingester (v1).
 *
 * Parses a conversations.json export downloaded from Claude.ai and ingests
 * the conversations into the knowledge graph.
 *
 * Each conversation produces:
 *  - A `conversation` node (title, timestamps).
 *  - `note` nodes for each human message (text content as excerpt).
 *  - `PART_OF` edges linking messages to the conversation.
 *
 * Configuration (env vars):
 *   CLAUDE_EXPORT_FILE  — path to conversations.json (required).
 *
 * Positional argument is also accepted:
 *   node scripts/ingest-claude-export.mjs ~/conversations.json
 *
 * Usage:
 *   node scripts/ingest-claude-export.mjs ~/Downloads/conversations.json
 *   CLAUDE_EXPORT_FILE=~/conversations.json node scripts/ingest-claude-export.mjs
 */

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GraphBuilder, loadGraph, saveGraph, stableId } from './lib/graph-store.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const GRAPH_PATH = join(REPO_ROOT, 'data', 'graph.json');

const SOURCE_ID = 'claude_export';
const MAX_EXCERPT = 400;

async function resolveExportPath() {
  const arg = process.argv.slice(2).find((a) => !a.startsWith('-'));
  if (arg) return resolve(arg);
  if (process.env.CLAUDE_EXPORT_FILE) return resolve(process.env.CLAUDE_EXPORT_FILE.trim());
  return null;
}

/** Extract plain text from a Claude message content array. */
function extractText(content) {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : '';
  return content
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n')
    .trim();
}

async function main() {
  const filePath = await resolveExportPath();
  if (!filePath) {
    console.error(
      'No export file specified.\n' +
      'Usage: node scripts/ingest-claude-export.mjs /path/to/conversations.json\n' +
      '  or set CLAUDE_EXPORT_FILE=/path/to/conversations.json',
    );
    process.exit(1);
  }

  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    console.error(`Cannot read file: ${err.message}`);
    process.exit(1);
  }

  let conversations;
  try {
    conversations = JSON.parse(raw);
  } catch (err) {
    console.error(`Invalid JSON: ${err.message}`);
    process.exit(1);
  }

  if (!Array.isArray(conversations)) conversations = [conversations];

  console.log(`Parsing ${conversations.length} conversation(s)...`);

  const existing = await loadGraph(GRAPH_PATH);
  const builder = new GraphBuilder(existing);

  let convsIngested = 0;
  let msgsIngested = 0;

  for (const conv of conversations) {
    if (!conv || typeof conv !== 'object') continue;
    const convId = conv.uuid || conv.id || stableId(SOURCE_ID, JSON.stringify(conv).slice(0, 80));
    const title = (conv.name || conv.title || '(Untitled conversation)').slice(0, 200);
    const createdAt = conv.created_at || conv.createdAt || undefined;

    const convNodeId = stableId(SOURCE_ID, `conv:${convId}`);
    builder.upsertNode({
      id: convNodeId,
      label: title,
      type: 'conversation',
      sourceId: SOURCE_ID,
      createdAt,
      metadata: {
        uuid: convId,
        messageCount: Array.isArray(conv.chat_messages) ? conv.chat_messages.length : 0,
      },
    });
    convsIngested += 1;

    const messages = conv.chat_messages || conv.messages || [];
    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') continue;
      const role = msg.sender || msg.role || 'unknown';
      // Only ingest human turns as note nodes — assistant output grows very large
      if (role !== 'human' && role !== 'user') continue;

      const text = extractText(msg.content || msg.text || '');
      if (!text) continue;

      const msgId = stableId(SOURCE_ID, `msg:${convId}:${msg.uuid || msg.id || text.slice(0, 40)}`);
      builder.upsertNode({
        id: msgId,
        label: text.slice(0, 80),
        type: 'note',
        sourceId: SOURCE_ID,
        createdAt: msg.created_at || msg.createdAt || createdAt,
        metadata: {
          excerpt: text.slice(0, MAX_EXCERPT),
          role,
          wordCount: text.split(/\s+/).filter(Boolean).length,
        },
      });
      builder.upsertEdge({ source: msgId, target: convNodeId, relation: 'PART_OF', weight: 0.6 });
      msgsIngested += 1;
    }
  }

  builder.recordSource(SOURCE_ID, { conversations: convsIngested, messages: msgsIngested });
  await saveGraph(GRAPH_PATH, builder.graph);

  console.log(`Ingested ${convsIngested} conversation(s) · ${msgsIngested} message node(s).`);
  console.log(`Graph: ${builder.graph.nodes.length} nodes · ${builder.graph.edges.length} edges`);
  console.log(`Wrote ${GRAPH_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
