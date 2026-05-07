import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GraphBuilder, loadGraph, saveGraph, stableId } from './lib/graph-store.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const GRAPH_PATH = join(REPO_ROOT, 'data', 'graph.json');
const CLAUDE_HOME = process.env.CLAUDE_HOME || join(homedir(), '.claude');
// CLAUDE_CODE_FILES is the env var the browser wizard uses when the user picks
// their ~/.claude/projects folder; the dev server writes them to a tmp dir and
// passes that path here. Otherwise default to the on-disk projects/ subdir.
const PROJECTS_DIR = process.env.CLAUDE_CODE_FILES || process.env.CLAUDE_PROJECTS_DIR
  || join(CLAUDE_HOME, 'projects');

const SOURCE_ID = 'claude_code';

async function main() {
  let projectDirs;
  try {
    const entries = await readdir(PROJECTS_DIR, { withFileTypes: true });
    projectDirs = entries
      .filter((d) => d.isDirectory())
      .map((d) => join(PROJECTS_DIR, d.name));
    // When the dev server materialises a browser folder pick into a tmp dir,
    // it can land flat at the root (no per-project subdirs). Treat the root
    // itself as a single project in that case so .jsonl files don't get
    // ignored just because the user picked them directly.
    const hasFlatJsonl = entries.some((d) => d.isFile() && d.name.endsWith('.jsonl'));
    if (projectDirs.length === 0 && hasFlatJsonl) {
      projectDirs = [PROJECTS_DIR];
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error(`No Claude Code data found at ${PROJECTS_DIR}`);
      console.error('Set CLAUDE_HOME or use Claude Code first to generate conversations.');
      process.exit(1);
    }
    throw err;
  }

  const existing = await loadGraph(GRAPH_PATH);
  const builder = new GraphBuilder(existing);

  let sessionCount = 0;
  let messageCount = 0;

  for (const dir of projectDirs) {
    const projectInfo = await ingestProject(builder, dir);
    sessionCount += projectInfo.sessions;
    messageCount += projectInfo.messages;
  }

  builder.recordSource(SOURCE_ID, {
    projects: projectDirs.length,
    sessions: sessionCount,
    messages: messageCount,
  });

  await saveGraph(GRAPH_PATH, builder.graph);

  console.log(
    `Ingested ${projectDirs.length} project(s), ${sessionCount} session(s), ${messageCount} message(s).`,
  );
  console.log(`Graph: ${builder.graph.nodes.length} nodes · ${builder.graph.edges.length} edges`);
  console.log(`Wrote ${GRAPH_PATH}`);
}

async function ingestProject(builder, projectDir) {
  const sessionFiles = (await readdir(projectDir))
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => join(projectDir, f));

  if (sessionFiles.length === 0) return { sessions: 0, messages: 0 };

  const folderName = basename(projectDir);
  let totalMessages = 0;
  const sessionsAggregate = [];
  let projectCwd = null;

  for (const file of sessionFiles) {
    const session = await readSession(file);
    if (!session) continue;
    if (session.cwd) projectCwd = session.cwd;
    sessionsAggregate.push(session);
    totalMessages += session.messageCount;
  }

  if (sessionsAggregate.length === 0) return { sessions: 0, messages: 0 };

  const projectLabel = projectCwd ? basename(projectCwd) : decodeFolderName(folderName);
  const projectId = stableId('project', projectCwd || folderName);
  builder.upsertNode({
    id: projectId,
    label: projectLabel,
    type: 'project',
    sourceId: SOURCE_ID,
    metadata: {
      cwd: projectCwd || null,
      folder: folderName,
      sessions: sessionsAggregate.length,
      messages: totalMessages,
    },
  });

  for (const session of sessionsAggregate) {
    const convId = stableId('conversation', session.sessionId || session.path);
    const label = sessionLabel(session);
    builder.upsertNode({
      id: convId,
      label,
      type: 'conversation',
      sourceId: SOURCE_ID,
      createdAt: session.firstTimestamp,
      metadata: {
        sessionId: session.sessionId,
        messages: session.messageCount,
        firstTimestamp: session.firstTimestamp,
        lastTimestamp: session.lastTimestamp,
        gitBranch: session.gitBranch,
        cwd: session.cwd,
        path: session.path.replace(homedir(), '~'),
      },
    });

    builder.upsertEdge({
      source: projectId,
      target: convId,
      relation: 'CONTAINS',
      weight: 0.6,
    });

    for (const [model, count] of session.models) {
      const modelId = stableId('model', model);
      builder.upsertNode({
        id: modelId,
        label: model,
        type: 'model',
        sourceId: SOURCE_ID,
        metadata: { provider: 'anthropic' },
      });
      builder.upsertEdge({
        source: convId,
        target: modelId,
        relation: 'USED_MODEL',
        weight: Math.min(1, 0.3 + count / 50),
        metadata: { count },
      });
    }

    for (const [tool, count] of session.tools) {
      const toolId = stableId('tool', tool);
      builder.upsertNode({
        id: toolId,
        label: tool,
        type: 'tool',
        sourceId: SOURCE_ID,
        metadata: { calls: count },
      });
      builder.upsertEdge({
        source: convId,
        target: toolId,
        relation: 'USED',
        weight: Math.min(1, 0.2 + count / 25),
        metadata: { count },
      });
    }

    for (const [path, count] of session.files) {
      const fileId = stableId('file', path);
      builder.upsertNode({
        id: fileId,
        label: basename(path),
        type: 'file',
        sourceId: SOURCE_ID,
        metadata: { path, touches: count },
      });
      builder.upsertEdge({
        source: convId,
        target: fileId,
        relation: 'TOUCHED',
        weight: Math.min(1, 0.2 + count / 10),
        metadata: { count },
      });
      if (projectCwd && path.startsWith(projectCwd)) {
        builder.upsertEdge({
          source: fileId,
          target: projectId,
          relation: 'PART_OF',
          weight: 0.4,
        });
      }
    }
  }

  return { sessions: sessionsAggregate.length, messages: totalMessages };
}

async function readSession(path) {
  const text = await readFile(path, 'utf8');
  const lines = text.split('\n').filter(Boolean);
  if (lines.length === 0) return null;

  const tools = new Map();
  const files = new Map();
  const models = new Map();
  let messageCount = 0;
  let firstTimestamp = null;
  let lastTimestamp = null;
  let firstUserText = null;
  let summary = null;
  let aiTitle = null;
  let sessionId = null;
  let cwd = null;
  let gitBranch = null;

  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }

    sessionId = sessionId || entry.sessionId;
    cwd = cwd || entry.cwd;
    gitBranch = gitBranch || entry.gitBranch;

    if (entry.timestamp) {
      if (!firstTimestamp || entry.timestamp < firstTimestamp) firstTimestamp = entry.timestamp;
      if (!lastTimestamp || entry.timestamp > lastTimestamp) lastTimestamp = entry.timestamp;
    }

    if (entry.type === 'summary' && entry.summary) summary = entry.summary;
    if (entry.type === 'ai-title' && (entry.title || entry.content)) {
      aiTitle = entry.title || entry.content;
    }

    if (entry.type !== 'user' && entry.type !== 'assistant') continue;
    const msg = entry.message;
    if (!msg || typeof msg !== 'object') continue;
    messageCount += 1;

    if (entry.type === 'assistant' && msg.model) {
      models.set(msg.model, (models.get(msg.model) || 0) + 1);
    }

    const content = msg.content;
    if (typeof content === 'string') {
      if (entry.type === 'user' && !firstUserText) firstUserText = content;
      continue;
    }
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && entry.type === 'user' && !firstUserText) {
        firstUserText = block.text;
      }
      if (block.type === 'tool_use') {
        const name = block.name;
        if (name) tools.set(name, (tools.get(name) || 0) + 1);
        for (const path of extractFilePaths(block.input)) {
          files.set(path, (files.get(path) || 0) + 1);
        }
      }
    }
  }

  return {
    path,
    sessionId,
    cwd,
    gitBranch,
    messageCount,
    firstTimestamp,
    lastTimestamp,
    firstUserText,
    summary,
    aiTitle,
    tools,
    files,
    models,
  };
}

function extractFilePaths(input) {
  const out = [];
  if (!input || typeof input !== 'object') return out;
  for (const key of ['file_path', 'path', 'notebook_path', 'filePath']) {
    const v = input[key];
    if (typeof v === 'string' && v.startsWith('/')) out.push(v);
  }
  return out;
}

function sessionLabel(session) {
  const candidate = session.aiTitle || session.summary || session.firstUserText || session.sessionId;
  if (!candidate) return 'Untitled conversation';
  const oneline = String(candidate).replace(/\s+/g, ' ').trim();
  return oneline.length > 80 ? oneline.slice(0, 79) + '…' : oneline;
}

function decodeFolderName(name) {
  const stripped = name.startsWith('-') ? name.slice(1) : name;
  return '/' + stripped.replace(/-/g, '/');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
