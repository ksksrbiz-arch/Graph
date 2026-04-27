/**
 * GitHub ingester (v1).
 *
 * Fetches repositories, issues, and pull requests from the GitHub API and
 * ingests them into the knowledge graph.
 *
 * Each repository produces:
 *  - A `repo` node (name, description, language, stars, forks, URL).
 *  - `tag` nodes for topics.
 *  - `TAGGED_WITH` edges.
 *
 * Each issue / pull request produces:
 *  - An `issue` / `pr` node.
 *  - A `person` node for the author.
 *  - `AUTHORED_BY` edge.
 *  - `PART_OF` edge linking the item to its repository.
 *
 * Configuration (env vars):
 *   GITHUB_TOKEN        — personal access token or OAuth token (required).
 *   GITHUB_LOGIN        — GitHub username/org to fetch. Defaults to the
 *                         authenticated user.
 *   GITHUB_REPOS_LIMIT  — max repos to fetch (default: 50).
 *   GITHUB_ITEMS_LIMIT  — max issues+PRs per repo (default: 30).
 *
 * Usage:
 *   GITHUB_TOKEN=ghp_... node scripts/ingest-github.mjs
 */

import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GraphBuilder, loadGraph, saveGraph, stableId } from './lib/graph-store.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const GRAPH_PATH = join(REPO_ROOT, 'data', 'graph.json');

const SOURCE_ID = 'github';
const GH_API = 'https://api.github.com';
const TOKEN = process.env.GITHUB_TOKEN;
const LOGIN = process.env.GITHUB_LOGIN || null;
const REPOS_LIMIT = Number(process.env.GITHUB_REPOS_LIMIT || 50);
const ITEMS_LIMIT = Number(process.env.GITHUB_ITEMS_LIMIT || 30);

if (!TOKEN) {
  console.error(
    'Missing required env var: GITHUB_TOKEN must be set.\n' +
    'Create a personal access token at https://github.com/settings/tokens',
  );
  process.exit(1);
}

function ghFetch(path, params = {}) {
  const url = new URL(`${GH_API}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  return fetch(url.toString(), {
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    },
  });
}

async function ghJson(path, params = {}) {
  const res = await ghFetch(path, params);
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function fetchAuthenticatedLogin() {
  const user = await ghJson('/user');
  return user?.login || null;
}

async function fetchRepos(login) {
  const allRepos = [];
  let page = 1;
  while (allRepos.length < REPOS_LIMIT) {
    const perPage = Math.min(100, REPOS_LIMIT - allRepos.length);
    const data = await ghJson(`/users/${login}/repos`, {
      sort: 'updated',
      per_page: perPage,
      page,
    });
    if (!Array.isArray(data) || data.length === 0) break;
    allRepos.push(...data);
    if (data.length < perPage) break;
    page += 1;
  }
  return allRepos;
}

async function fetchIssues(repoFullName) {
  const data = await ghJson(`/repos/${repoFullName}/issues`, {
    state: 'all',
    per_page: Math.min(ITEMS_LIMIT, 100),
    sort: 'updated',
  });
  return Array.isArray(data) ? data : [];
}

async function main() {
  const login = LOGIN || (await fetchAuthenticatedLogin());
  if (!login) {
    console.error('Could not determine GitHub login. Set GITHUB_LOGIN or ensure GITHUB_TOKEN is valid.');
    process.exit(1);
  }

  console.log(`Fetching GitHub data for ${login}...`);

  let repos;
  try {
    repos = await fetchRepos(login);
  } catch (err) {
    console.error(`Failed to fetch repos: ${err.message}`);
    process.exit(1);
  }

  console.log(`Found ${repos.length} repo(s).`);

  const existing = await loadGraph(GRAPH_PATH);
  const builder = new GraphBuilder(existing);

  let reposIngested = 0;
  let issuesIngested = 0;
  let prsIngested = 0;
  const personsCreated = new Set();

  for (const repo of repos) {
    const repoId = stableId(SOURCE_ID, `repo:${repo.full_name}`);
    const topics = Array.isArray(repo.topics) ? repo.topics : [];

    builder.upsertNode({
      id: repoId,
      label: repo.full_name,
      type: 'repo',
      sourceId: SOURCE_ID,
      sourceUrl: repo.html_url,
      createdAt: repo.created_at || undefined,
      metadata: {
        description: repo.description ? repo.description.slice(0, 300) : undefined,
        language: repo.language || undefined,
        stars: repo.stargazers_count,
        forks: repo.forks_count,
        openIssues: repo.open_issues_count,
        private: repo.private,
        fork: repo.fork,
        topics,
      },
    });
    reposIngested += 1;

    for (const topic of topics) {
      const tagId = stableId('tag', topic.toLowerCase());
      builder.upsertNode({
        id: tagId,
        label: `#${topic.toLowerCase()}`,
        type: 'tag',
        sourceId: SOURCE_ID,
        metadata: { tag: topic.toLowerCase() },
      });
      builder.upsertEdge({ source: repoId, target: tagId, relation: 'TAGGED_WITH', weight: 0.35 });
    }

    // Fetch issues + PRs for this repo (skip forks to keep it manageable)
    if (!repo.fork) {
      let items;
      try {
        items = await fetchIssues(repo.full_name);
      } catch {
        items = [];
      }
      for (const item of items.slice(0, ITEMS_LIMIT)) {
        const isPr = !!item.pull_request;
        const itemId = stableId(SOURCE_ID, `${isPr ? 'pr' : 'issue'}:${repo.full_name}#${item.number}`);
        builder.upsertNode({
          id: itemId,
          label: `${repo.name}#${item.number}: ${(item.title || '').slice(0, 120)}`,
          type: isPr ? 'pr' : 'issue',
          sourceId: SOURCE_ID,
          sourceUrl: item.html_url,
          createdAt: item.created_at || undefined,
          metadata: {
            number: item.number,
            state: item.state,
            labels: (item.labels || []).map((l) => l.name),
            repo: repo.full_name,
          },
        });
        builder.upsertEdge({ source: itemId, target: repoId, relation: 'PART_OF', weight: 0.6 });
        if (isPr) prsIngested += 1;
        else issuesIngested += 1;

        if (item.user?.login) {
          const personId = stableId('person', item.user.login.toLowerCase());
          builder.upsertNode({
            id: personId,
            label: item.user.login,
            type: 'person',
            sourceId: SOURCE_ID,
            sourceUrl: item.user.html_url,
            metadata: { githubLogin: item.user.login },
          });
          builder.upsertEdge({ source: itemId, target: personId, relation: 'AUTHORED_BY', weight: 0.7 });
          personsCreated.add(item.user.login);
        }
      }
    }
  }

  builder.recordSource(SOURCE_ID, {
    repos: reposIngested,
    issues: issuesIngested,
    prs: prsIngested,
    persons: personsCreated.size,
  });

  await saveGraph(GRAPH_PATH, builder.graph);

  console.log(
    `Ingested ${reposIngested} repo(s) · ${issuesIngested} issue(s) · ${prsIngested} PR(s) · ${personsCreated.size} person(s).`,
  );
  console.log(`Graph: ${builder.graph.nodes.length} nodes · ${builder.graph.edges.length} edges`);
  console.log(`Wrote ${GRAPH_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
