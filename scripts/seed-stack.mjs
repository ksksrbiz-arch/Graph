#!/usr/bin/env node
/**
 * Seed the local docker-compose stack with mock data so a fresh
 * `pnpm stack:up && pnpm stack:seed` shows a populated graph + brain.
 *
 * Phase 0 DoD §12: "`docker compose up` brings up all services with seed
 * data". The compose file alone only spins up empty databases — this script
 * fills them.
 *
 * Steps:
 *   1. Generate (or reuse) a mock graph.json under `data/seed/graph.json`.
 *   2. Bulk-MERGE it into Neo4j as KGNodes + KGEdges, owned by `userId=local`
 *      (the demo user the Cloudflare-hosted SPA talks to).
 *   3. Print the resulting counts so the operator can sanity-check.
 *
 * Idempotent: safe to re-run. `MERGE` on `(KGNode {id, userId})` upserts.
 *
 * Env vars (defaults match docker-compose.yml):
 *   NEO4J_URI       bolt://localhost:7687
 *   NEO4J_USER      neo4j
 *   NEO4J_PASSWORD  password
 *   SEED_USER_ID    local
 *   SEED_NODES      120
 *   SEED_DENSITY    0.04
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const neo4j = require('neo4j-driver');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SEED_DIR = resolve(ROOT, 'data', 'seed');
const SEED_PATH = resolve(SEED_DIR, 'graph.json');

const URI = process.env.NEO4J_URI || 'bolt://localhost:7687';
const USER = process.env.NEO4J_USER || 'neo4j';
const PASS = process.env.NEO4J_PASSWORD || 'password';
const USER_ID = process.env.SEED_USER_ID || 'local';
const NODE_COUNT = Number(process.env.SEED_NODES || 120);
const DENSITY = Number(process.env.SEED_DENSITY || 0.04);

async function main() {
  const t0 = Date.now();
  const graph = await ensureSeedGraph();
  console.log(`[seed] using ${graph.nodes.length} nodes / ${graph.edges.length} edges (userId=${USER_ID})`);

  const driver = neo4j.driver(URI, neo4j.auth.basic(USER, PASS), { disableLosslessIntegers: true });
  await waitForNeo4j(driver);

  const session = driver.session();
  try {
    await session.executeWrite(async (tx) => {
      await tx.run('CREATE CONSTRAINT kgnode_id_user IF NOT EXISTS FOR (n:KGNode) REQUIRE (n.id, n.userId) IS UNIQUE');
      await tx.run('CREATE INDEX kgnode_type IF NOT EXISTS FOR (n:KGNode) ON (n.type)');
      await tx.run('CREATE FULLTEXT INDEX nodeLabels IF NOT EXISTS FOR (n:KGNode) ON EACH [n.label]');
    });

    console.log('[seed] upserting nodes…');
    const NB = 250;
    for (let i = 0; i < graph.nodes.length; i += NB) {
      const batch = graph.nodes.slice(i, i + NB).map((n) => ({
        id: String(n.id),
        userId: USER_ID,
        properties: {
          id: String(n.id),
          label: String(n.label ?? n.id),
          type: String(n.type ?? 'concept'),
          sourceId: String(n.sourceId ?? 'bookmarks'),
          createdAt: String(n.createdAt ?? new Date().toISOString()),
          updatedAt: String(n.updatedAt ?? new Date().toISOString()),
          metadataJson: JSON.stringify(n.metadata ?? {}),
        },
      }));
      await session.executeWrite((tx) =>
        tx.run(
          `UNWIND $rows AS row
           MERGE (n:KGNode {id: row.id, userId: row.userId})
           SET n += row.properties, n.userId = row.userId`,
          { rows: batch },
        ),
      );
    }

    console.log('[seed] upserting edges…');
    for (let i = 0; i < graph.edges.length; i += NB) {
      const batch = graph.edges.slice(i, i + NB).map((e) => ({
        source: String(e.source),
        target: String(e.target),
        userId: USER_ID,
        props: {
          id: String(e.id),
          relation: String(e.relation ?? 'RELATED_TO'),
          weight: Number.isFinite(Number(e.weight)) ? Number(e.weight) : 0.4,
          inferred: Boolean(e.inferred),
          createdAt: String(e.createdAt ?? new Date().toISOString()),
          metadataJson: JSON.stringify(e.metadata ?? {}),
        },
      }));
      await session.executeWrite((tx) =>
        tx.run(
          `UNWIND $rows AS row
           MATCH (a:KGNode {id: row.source, userId: row.userId})
           MATCH (b:KGNode {id: row.target, userId: row.userId})
           MERGE (a)-[r:REL {id: row.props.id}]->(b)
           SET r += row.props`,
          { rows: batch },
        ),
      );
    }

    const r = await session.executeRead((tx) =>
      tx.run(
        `MATCH (n:KGNode {userId: $userId})
         WITH count(n) AS n
         OPTIONAL MATCH (a:KGNode {userId: $userId})-[r:REL]->(:KGNode {userId: $userId})
         RETURN n, count(r) AS e`,
        { userId: USER_ID },
      ),
    );
    const row = r.records[0];
    console.log(`[seed] Neo4j: ${row.get('n')} nodes · ${row.get('e')} edges (userId=${USER_ID})`);
  } finally {
    await session.close();
    await driver.close();
  }

  console.log(`[seed] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('[seed] next: pnpm --filter @pkg/api start:dev → http://localhost:3001/api/docs');
}

async function ensureSeedGraph() {
  if (existsSync(SEED_PATH)) {
    try {
      const parsed = JSON.parse(readFileSync(SEED_PATH, 'utf8'));
      if (Array.isArray(parsed.nodes) && parsed.nodes.length > 0) return parsed;
    } catch {
      // fall through and regenerate
    }
  }
  console.log('[seed] generating mock graph (one-time)…');
  const { generateGraph } = await import(resolve(ROOT, 'packages/shared/dist/mocks/index.js'));
  const generated = generateGraph(NODE_COUNT, DENSITY, { seed: 42 });
  mkdirSync(SEED_DIR, { recursive: true });
  writeFileSync(SEED_PATH, JSON.stringify(generated, null, 2) + '\n', 'utf8');
  return generated;
}

async function waitForNeo4j(driver, attempts = 30, delayMs = 1000) {
  for (let i = 0; i < attempts; i++) {
    try {
      await driver.verifyConnectivity();
      return;
    } catch (err) {
      if (i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

main().catch((err) => {
  console.error('[seed] FAILED', err);
  process.exit(1);
});
