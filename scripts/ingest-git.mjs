/**
 * Git repository ingester.
 *
 * Discovers local git repositories and ingests their recent history into
 * the knowledge graph, creating `repo`, `commit`, and `author` nodes.
 * Files touched by commits are linked to any existing `file` nodes already
 * in the graph (e.g. from the Claude Code ingester), providing cross-source
 * contextual connections.
 *
 * Configuration (env vars):
 *   GIT_SCAN_DIRS  — colon-separated list of directories to recursively scan
 *                    for git repos (default: $HOME).
 *   GIT_SCAN_DEPTH — how many directory levels deep to search (default: 3).
 *   GIT_MAX_COMMITS — maximum commits to read per repo (default: 200).
 */

import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { GraphBuilder, loadGraph, saveGraph, stableId } from './lib/graph-store.mjs';

const execFileP = promisify(execFile);

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const GRAPH_PATH = join(REPO_ROOT, 'data', 'graph.json');

const SOURCE_ID = 'git';

const SCAN_DIRS = (process.env.GIT_SCAN_DIRS || homedir())
  .split(':')
  .map((p) => p.trim())
  .filter(Boolean);
const SCAN_DEPTH = Number(process.env.GIT_SCAN_DEPTH || 3);
const MAX_COMMITS = Number(process.env.GIT_MAX_COMMITS || 200);

async function main() {
  const existing = await loadGraph(GRAPH_PATH);
  const builder = new GraphBuilder(existing);

  // Build an index of file nodes already in the graph so we can link to them.
  const fileNodeByPath = new Map();
  for (const node of existing.nodes) {
    if (node.type === 'file' && node.metadata?.path) {
      fileNodeByPath.set(node.metadata.path, node.id);
    }
  }

  // Build an index of project nodes by cwd so we can link repos to them.
  const projectNodeByCwd = new Map();
  for (const node of existing.nodes) {
    if (node.type === 'project' && node.metadata?.cwd) {
      projectNodeByCwd.set(node.metadata.cwd, node.id);
    }
  }

  console.log(`Scanning for git repos in: ${SCAN_DIRS.join(', ')} (depth ${SCAN_DEPTH})`);
  const repoPaths = [];
  for (const dir of SCAN_DIRS) {
    await findGitRepos(dir, SCAN_DEPTH, repoPaths);
  }

  if (repoPaths.length === 0) {
    console.log('No git repositories found.');
    process.exit(0);
  }

  console.log(`Found ${repoPaths.length} git repo(s).`);

  let totalCommits = 0;
  let totalAuthors = 0;

  const authorsSeen = new Set();

  for (const repoPath of repoPaths) {
    const result = await ingestRepo(
      builder,
      repoPath,
      fileNodeByPath,
      projectNodeByCwd,
      authorsSeen,
    );
    totalCommits += result.commits;
    totalAuthors += result.newAuthors;
  }

  builder.recordSource(SOURCE_ID, {
    repos: repoPaths.length,
    commits: totalCommits,
    authors: authorsSeen.size,
  });

  await saveGraph(GRAPH_PATH, builder.graph);

  console.log(
    `Ingested ${repoPaths.length} repo(s), ${totalCommits} commit(s), ${authorsSeen.size} author(s).`,
  );
  console.log(`Graph: ${builder.graph.nodes.length} nodes · ${builder.graph.edges.length} edges`);
  console.log(`Wrote ${GRAPH_PATH}`);
}

/**
 * Recursively find directories that contain a `.git` folder.
 */
async function findGitRepos(dir, depth, out) {
  if (depth < 0) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  const hasGit = entries.some((e) => e.isDirectory() && e.name === '.git');
  if (hasGit) {
    out.push(dir);
    // Don't recurse into sub-repos (git submodules are handled by parent)
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Skip hidden directories (node_modules, .git siblings, etc.)
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    await findGitRepos(join(dir, entry.name), depth - 1, out);
  }
}

async function ingestRepo(builder, repoPath, fileNodeByPath, projectNodeByCwd, authorsSeen) {
  const repoName = basename(repoPath);
  const repoId = stableId('repo', repoPath);

  let remoteUrl = null;
  try {
    const { stdout } = await execFileP('git', ['-C', repoPath, 'remote', 'get-url', 'origin']);
    remoteUrl = stdout.trim() || null;
  } catch { /* no remote */ }

  let defaultBranch = 'HEAD';
  try {
    const { stdout } = await execFileP('git', ['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD']);
    defaultBranch = stdout.trim() || 'HEAD';
  } catch { /* ignore */ }

  builder.upsertNode({
    id: repoId,
    label: repoName,
    type: 'repo',
    sourceId: SOURCE_ID,
    metadata: {
      path: repoPath,
      remoteUrl,
      branch: defaultBranch,
    },
  });

  // Link repo to matching project node (contextual cross-source connection)
  const projectId = projectNodeByCwd.get(repoPath);
  if (projectId) {
    builder.upsertEdge({
      source: repoId,
      target: projectId,
      relation: 'SAME_AS',
      weight: 0.9,
    });
  }

  // Parse recent git log
  let logOutput;
  try {
    const { stdout } = await execFileP('git', [
      '-C', repoPath,
      'log',
      `--max-count=${MAX_COMMITS}`,
      '--format=%H\x1f%ae\x1f%an\x1f%aI\x1f%s',
      '--name-only',
      '--diff-filter=ACMR',
    ]);
    logOutput = stdout;
  } catch {
    return { commits: 0, newAuthors: 0 };
  }

  const commits = parseGitLog(logOutput);
  let newAuthors = 0;

  for (const commit of commits) {
    const commitId = stableId('commit', commit.hash);
    builder.upsertNode({
      id: commitId,
      label: commit.subject.length > 72 ? commit.subject.slice(0, 71) + '…' : commit.subject,
      type: 'commit',
      sourceId: SOURCE_ID,
      createdAt: commit.date,
      metadata: {
        hash: commit.hash,
        shortHash: commit.hash.slice(0, 8),
        date: commit.date,
        repo: repoPath,
      },
    });

    builder.upsertEdge({
      source: repoId,
      target: commitId,
      relation: 'CONTAINS',
      weight: 0.5,
    });

    // Author node
    const authorId = stableId('author', commit.authorEmail);
    if (!authorsSeen.has(commit.authorEmail)) {
      builder.upsertNode({
        id: authorId,
        label: commit.authorName,
        type: 'author',
        sourceId: SOURCE_ID,
        metadata: {
          email: commit.authorEmail,
          name: commit.authorName,
        },
      });
      authorsSeen.add(commit.authorEmail);
      newAuthors += 1;
    }
    builder.upsertEdge({
      source: commitId,
      target: authorId,
      relation: 'AUTHORED_BY',
      weight: 0.7,
    });

    // Files touched — link to existing file nodes for cross-source connections
    for (const relPath of commit.files) {
      const absPath = join(repoPath, relPath);

      // Link to pre-existing file node if present (contextual connection)
      const existingFileId = fileNodeByPath.get(absPath);
      if (existingFileId) {
        builder.upsertEdge({
          source: commitId,
          target: existingFileId,
          relation: 'MODIFIED',
          weight: 0.4,
        });
      } else {
        // Create a lightweight file node scoped to this repo
        const fileId = stableId('file', absPath);
        builder.upsertNode({
          id: fileId,
          label: basename(relPath),
          type: 'file',
          sourceId: SOURCE_ID,
          metadata: { path: absPath, relativePath: relPath },
        });
        builder.upsertEdge({
          source: commitId,
          target: fileId,
          relation: 'MODIFIED',
          weight: 0.4,
        });
        builder.upsertEdge({
          source: fileId,
          target: repoId,
          relation: 'PART_OF',
          weight: 0.4,
        });
        // Add to index so subsequent commits reuse the same node
        fileNodeByPath.set(absPath, fileId);
      }
    }
  }

  return { commits: commits.length, newAuthors };
}

/**
 * Parse the output of `git log --format=%H\x1f%ae\x1f%an\x1f%aI\x1f%s --name-only`.
 *
 * Each commit block looks like:
 *   <hash>\x1f<email>\x1f<name>\x1f<isodate>\x1f<subject>
 *   <blank line>
 *   file1
 *   file2
 *   <blank line>   ← separates commits
 */
function parseGitLog(output) {
  const commits = [];
  const blocks = output.split(/\n(?=[\da-f]{40}\x1f)/);

  for (const block of blocks) {
    const lines = block.split('\n');
    if (!lines[0]) continue;
    const headerParts = lines[0].split('\x1f');
    if (headerParts.length < 5) continue;

    const [hash, authorEmail, authorName, date, ...subjectParts] = headerParts;
    const subject = subjectParts.join('\x1f').trim();
    const files = lines.slice(1).map((l) => l.trim()).filter(Boolean);

    commits.push({ hash, authorEmail, authorName, date, subject, files });
  }

  return commits;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
