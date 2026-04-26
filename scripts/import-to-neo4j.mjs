#!/usr/bin/env node
/**
 * One-shot: read data/graph.json (v1 viewer format) and bulk-MERGE into
 * Neo4j as KGNodes + relationships in the shape the v2 ConnectomeLoader
 * expects (n.id, n.type, n.sourceId; relationships with id + weight).
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const neo4j = require('neo4j-driver');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const URI = process.env.NEO4J_URI || 'bolt://localhost:7687';
const USER = process.env.NEO4J_USER || 'neo4j';
const PASS = process.env.NEO4J_PASSWORD || 'password';

const SAFE_REL = (r) => String(r || 'RELATED_TO').replace(/[^A-Z_]/gi, '_').toUpperCase().slice(0, 32) || 'RELATED_TO';

async function main() {
  const t0 = Date.now();
  const path = resolve(ROOT, 'data', 'graph.json');
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const nodes = raw.nodes || [];
  const edges = raw.edges || raw.links || [];
  console.log(`[import] reading ${nodes.length} nodes, ${edges.length} edges`);

  const driver = neo4j.driver(URI, neo4j.auth.basic(USER, PASS), {
    disableLosslessIntegers: true,
  });
  await driver.verifyConnectivity();
  const session = driver.session();
  try {
    console.log('[import] schema');
    await session.executeWrite(async (tx) => {
      await tx.run('CREATE CONSTRAINT kgnode_id IF NOT EXISTS FOR (n:KGNode) REQUIRE n.id IS UNIQUE');
      await tx.run('CREATE INDEX kgnode_type IF NOT EXISTS FOR (n:KGNode) ON (n.type)');
      await tx.run('CREATE FULLTEXT INDEX nodeLabels IF NOT EXISTS FOR (n:KGNode) ON EACH [n.label]');
    });

    console.log('[import] nodes');
    const NB = 500;
    for (let i = 0; i < nodes.length; i += NB) {
      const batch = nodes.slice(i, i + NB).map((n) => ({
        id: String(n.id),
        properties: {
          id: String(n.id),
          label: String(n.label ?? n.id),
          type: String(n.type ?? 'concept'),
          sourceId: String(n.source ?? n.sourceId ?? 'unknown'),
          createdAt: String(n.createdAt ?? new Date().toISOString()),
          updatedAt: String(n.updatedAt ?? new Date().toISOString()),
          metadata: JSON.stringify(n.metadata ?? {}),
        },
      }));
      await session.executeWrite((tx) =>
        tx.run(
          'UNWIND $rows AS row MERGE (n:KGNode {id: row.id}) SET n += row.properties',
          { rows: batch },
        ),
      );
      process.stdout.write(`\r  ${Math.min(i + NB, nodes.length)}/${nodes.length}`);
    }
    process.stdout.write('\n');

    console.log('[import] edges');
    // Group by relation
    const byRel = new Map();
    for (const e of edges) {
      const rel = SAFE_REL(e.relation || e.type || 'RELATED_TO');
      const list = byRel.get(rel) || [];
      list.push(e);
      byRel.set(rel, list);
    }
    for (const [rel, list] of byRel) {
      for (let i = 0; i < list.length; i += NB) {
        const batch = list.slice(i, i + NB).map((e) => ({
          source: String(e.source ?? e.from ?? e.pre),
          target: String(e.target ?? e.to ?? e.post),
          props: {
            id: String(e.id ?? `${e.source}->${e.target}::${rel}`),
            weight: Number.isFinite(Number(e.weight)) ? Number(e.weight) : 0.5,
            metadata: JSON.stringify(e.metadata ?? {}),
          },
        }));
        await session.executeWrite((tx) =>
          tx.run(
            `UNWIND $rows AS row
             MATCH (a:KGNode {id: row.source}), (b:KGNode {id: row.target})
             MERGE (a)-[r:${rel} {id: row.props.id}]->(b)
             SET r += row.props`,
            { rows: batch },
          ),
        );
      }
      console.log(`  ${rel.padEnd(20)} ${list.length}`);
    }

    const r = await session.executeRead((tx) =>
      tx.run('MATCH (n:KGNode) WITH count(n) AS n MATCH ()-[r]->() RETURN n, count(r) AS e'),
    );
    const row = r.records[0];
    console.log(`[import] Neo4j: ${row.get('n')} nodes · ${row.get('e')} edges`);
  } finally {
    await session.close();
    await driver.close();
  }
  console.log(`[import] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
main().catch((e) => { console.error('[import] FAIL', e); process.exit(1); });
