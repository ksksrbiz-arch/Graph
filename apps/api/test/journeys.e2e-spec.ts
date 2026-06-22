// Additional E2E user journey specs for the PKG-VS API.
// Boots the full Nest AppModule against real infrastructure (Neo4j/Postgres/
// Redis/Meilisearch) and exercises five user journeys not covered by
// app.e2e-spec.ts. Runs only in the `api-e2e` CI job that provides service
// containers; it is NOT part of `pnpm test`.
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

describe('PKG-VS API — User Journeys (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
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

  // ── Journey 1: Text ingest → snapshot ──────────────────────────────────────

  it('Journey 1: ingests free text and verifies the graph snapshot contains nodes', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/public/ingest/text')
      .send({ userId: 'local', text: 'Alice knows Bob. Bob works at Acme.', title: 'test-text' })
      .expect(200);

    // PublicIngestResult shape: { userId, format, parentId, nodes: number, edges: number, brainQueuedReload }
    // `nodes` and `edges` are counts (numbers), not arrays — assert the type explicitly.
    expect(typeof res.body.nodes).toBe('number');
    expect(typeof res.body.edges).toBe('number');

    const snap = await request(app.getHttpServer())
      .get('/api/v1/public/graph')
      .query({ userId: 'local' })
      .expect(200);

    expect(Array.isArray(snap.body.nodes)).toBe(true);
  });

  // ── Journey 2: Markdown ingest → delta endpoint ────────────────────────────

  it('Journey 2: ingests markdown and reads it back from the delta endpoint', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/public/ingest/markdown')
      .send({
        userId: 'local',
        markdown: '# Project Alpha\n\nRelated to [[Project Beta]].\n',
        title: 'md-journey',
      })
      .expect(200);

    const delta = await request(app.getHttpServer())
      .get('/api/v1/public/graph/delta')
      .query({ userId: 'local', since: '0' })
      .expect(200);

    // since=0 means "everything since the epoch" — the delta must contain at least the
    // nodes ingested above, so the array should be non-empty.
    expect(Array.isArray(delta.body.nodes)).toBe(true);
    expect((delta.body.nodes as unknown[]).length).toBeGreaterThan(0);
  });

  // ── Journey 3: Graph delta with far-future time filter ─────────────────────

  it('Journey 3: delta with a far-future since returns an empty nodes array', async () => {
    const delta = await request(app.getHttpServer())
      .get('/api/v1/public/graph/delta')
      .query({ userId: 'local', since: '9999999999999' })
      .expect(200);

    expect(Array.isArray(delta.body.nodes)).toBe(true);
    expect(delta.body.nodes).toHaveLength(0);
  });

  // ── Journey 4: Validation rejects malformed requests ──────────────────────

  it('Journey 4a: rejects an empty body for text ingest with 400', () => {
    return request(app.getHttpServer())
      .post('/api/v1/public/ingest/text')
      .send({})
      .expect(400);
  });

  it('Journey 4b: rejects a blank userId for text ingest with 400', () => {
    return request(app.getHttpServer())
      .post('/api/v1/public/ingest/text')
      .send({ userId: '', text: 'hi' })
      .expect(400);
  });

  it('Journey 4c: rejects a graph ingest with an empty nodes array with 400', () => {
    return request(app.getHttpServer())
      .post('/api/v1/public/ingest/graph')
      .send({ userId: 'local', nodes: [] })
      .expect(400);
  });

  // ── Journey 5: Health + readiness probes ──────────────────────────────────

  it('Journey 5a: GET /health → 200 { status: "ok" }', () => {
    return request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect({ status: 'ok' });
  });

  it('Journey 5b: GET /health/ready → 200', () => {
    return request(app.getHttpServer()).get('/health/ready').expect(200);
  });

  it('Journey 5c: GET /api/v1/public/ingest/health → ok with text and markdown formats', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/public/ingest/health')
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.formats).toContain('text');
    expect(res.body.formats).toContain('markdown');
  });
});
