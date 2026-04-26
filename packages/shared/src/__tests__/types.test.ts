import { describe, expect, it } from 'vitest';
import {
  ConnectorConfigSchema,
  EnvSchema,
  KGEdgeSchema,
  KGNodeSchema,
} from '../index.js';
import { generateGraph } from '../mocks/index.js';

describe('shared schemas', () => {
  it('round-trips a generated node through KGNodeSchema', () => {
    const { nodes } = generateGraph(50, 0.01, { seed: 42 });
    for (const node of nodes) expect(() => KGNodeSchema.parse(node)).not.toThrow();
  });

  it('round-trips generated edges through KGEdgeSchema', () => {
    const { edges } = generateGraph(50, 0.05, { seed: 42 });
    for (const edge of edges) expect(() => KGEdgeSchema.parse(edge)).not.toThrow();
  });

  it('rejects a node with an unknown type', () => {
    const result = KGNodeSchema.safeParse({
      id: '00000000-0000-4000-8000-000000000000',
      label: 'x',
      type: 'not-a-type',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},
      sourceId: 'github',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an edge with weight > 1', () => {
    const result = KGEdgeSchema.safeParse({
      id: '00000000-0000-4000-8000-000000000001',
      source: 'a',
      target: 'b',
      relation: 'MENTIONS',
      weight: 1.5,
      inferred: false,
      createdAt: new Date().toISOString(),
      metadata: {},
    });
    expect(result.success).toBe(false);
  });
});

describe('ConnectorConfigSchema', () => {
  it('accepts a fully-populated config', () => {
    const ok = ConnectorConfigSchema.safeParse({
      id: 'github',
      userId: '00000000-0000-4000-8000-000000000002',
      enabled: true,
      credentials: { ciphertext: 'abc', iv: 'def', keyId: 'k1' },
      syncIntervalMinutes: 60,
    });
    expect(ok.success).toBe(true);
  });
});

describe('EnvSchema', () => {
  const validEnv = {
    NODE_ENV: 'test',
    API_PORT: '3001',
    POSTGRES_URL: 'postgresql://pkg:pkg@localhost:5432/pkg',
    NEO4J_URI: 'bolt://localhost:7687',
    NEO4J_USER: 'neo4j',
    NEO4J_PASSWORD: 'password',
    REDIS_URL: 'redis://localhost:6379',
    MEILI_HOST: 'http://localhost:7700',
    MEILI_MASTER_KEY: 'k',
    JWT_SECRET: 'x'.repeat(32),
    KEK_BASE64: Buffer.alloc(32).toString('base64'),
  };

  it('parses a valid env', () => {
    expect(EnvSchema.parse(validEnv).API_PORT).toBe(3001);
  });

  it('rejects a too-short JWT_SECRET', () => {
    const result = EnvSchema.safeParse({ ...validEnv, JWT_SECRET: 'short' });
    expect(result.success).toBe(false);
  });

  it('rejects KEK that does not decode to 32 bytes', () => {
    const result = EnvSchema.safeParse({ ...validEnv, KEK_BASE64: 'aGVsbG8=' });
    expect(result.success).toBe(false);
  });
});
