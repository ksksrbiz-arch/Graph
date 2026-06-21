// End-to-end smoke for the integrated v3 API. Boots the full Nest AppModule
// (all modules + 14 connectors wired) against real Neo4j/Postgres/Redis/
// Meilisearch and exercises liveness, readiness, and the public graph
// ingest → snapshot round-trip. Runs only in the `api-e2e` CI job, which
// provides the service containers; it is NOT part of `pnpm test`.
//
// Required env (CI sets real values; the defaults below let it run against a
// local `pnpm stack:up`):
process.env.NEO4J_URI ??= 'bolt://localhost:7687';
process.env.NEO4J_USER ??= 'neo4j';
process.env.NEO4J_PASSWORD ??= 'password';
process.env.POSTGRES_URL ??= 'postgresql://pkg:pkg@localhost:5432/pkg';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.MEILI_HOST ??= 'http://localhost:7700';
process.env.MEILI_MASTER_KEY ??= 'masterKey';
process.env.JWT_SECRET ??= 'test-jwt-secret-32-bytes-minimum-xx';
process.env.KEK_BASE64 ??= 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
process.env.PUBLIC_INGEST_USER_IDS ??= 'local';

import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { IdempotencyInterceptor, IdempotencyService } from '../src/shared/idempotency';

interface SnapshotNode {
  id: string;
}

describe('PKG-VS API (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    // Build via NestFactory (the production bootstrap path in main.ts) rather
    // than the testing module, and mirror main.ts's global wiring.
    app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
    app.setGlobalPrefix('api/v1', { exclude: ['health', 'health/ready', 'metrics'] });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    app.useGlobalInterceptors(
      new IdempotencyInterceptor(app.get(IdempotencyService), app.get(Reflector)),
    );
    await app.init();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it('GET /health → 200 (liveness)', () => {
    return request(app.getHttpServer()).get('/health').expect(200).expect({ status: 'ok' });
  });

  it('GET /api/v1/public/ingest/health advertises the graph format', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/public/ingest/health').expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.formats).toContain('graph');
  });

  it('GET /health/ready → 200 with all services up', () => {
    return request(app.getHttpServer()).get('/health/ready').expect(200);
  });

  it('ingests a graph fragment and reads it back from the snapshot', async () => {
    const node = { id: 'e2e-node-1', label: 'E2E Node', type: 'note' };
    const edgeTarget = { id: 'e2e-node-2', label: 'E2E Target', type: 'concept' };

    const ingest = await request(app.getHttpServer())
      .post('/api/v1/public/ingest/graph')
      .send({
        userId: 'local',
        nodes: [node, edgeTarget],
        edges: [{ source: 'e2e-node-1', target: 'e2e-node-2', relation: 'RELATED_TO' }],
        sourceId: 'e2e',
      })
      .expect(200);

    expect(ingest.body.nodes).toBe(2);
    expect(ingest.body.edges).toBe(1);

    const snap = await request(app.getHttpServer())
      .get('/api/v1/public/graph')
      .query({ userId: 'local' })
      .expect(200);

    const ids = (snap.body.nodes as SnapshotNode[]).map((n) => n.id);
    expect(ids).toContain('e2e-node-1');
    expect(ids).toContain('e2e-node-2');
  });

  it('rejects ingest for a userId not on the allowlist (403)', () => {
    return request(app.getHttpServer())
      .post('/api/v1/public/ingest/graph')
      .send({ userId: 'not-allowed', nodes: [{ id: 'x', label: 'x', type: 'note' }] })
      .expect(403);
  });
});
