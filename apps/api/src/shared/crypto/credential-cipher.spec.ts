import { CredentialCipher } from './credential-cipher';
import { resetEnvCache } from '../../config/env';

describe('CredentialCipher', () => {
  let cipher: CredentialCipher;

  beforeAll(() => {
    process.env.NODE_ENV = 'test';
    process.env.API_PORT = '3001';
    process.env.POSTGRES_URL = 'postgresql://u:p@localhost:5432/d';
    process.env.NEO4J_URI = 'bolt://localhost:7687';
    process.env.NEO4J_USER = 'neo4j';
    process.env.NEO4J_PASSWORD = 'password';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.MEILI_HOST = 'http://localhost:7700';
    process.env.MEILI_MASTER_KEY = 'k';
    process.env.JWT_SECRET = 'x'.repeat(32);
    process.env.KEK_BASE64 = Buffer.alloc(32, 7).toString('base64');
    resetEnvCache();
    cipher = new CredentialCipher();
  });

  it('round-trips a token', () => {
    const token = 'ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    const encrypted = cipher.encrypt(token);
    expect(encrypted.ciphertext).not.toContain(token);
    expect(cipher.decrypt(encrypted)).toBe(token);
  });

  it('rejects tampered ciphertext', () => {
    const encrypted = cipher.encrypt('hello');
    const tamperedBytes = Buffer.from(encrypted.ciphertext, 'base64');
    tamperedBytes[0] = (tamperedBytes[0] ?? 0) ^ 0xff;
    const tampered = { ...encrypted, ciphertext: tamperedBytes.toString('base64') };
    expect(() => cipher.decrypt(tampered)).toThrow();
  });

  it('rejects an unknown keyId', () => {
    const encrypted = cipher.encrypt('hello');
    expect(() => cipher.decrypt({ ...encrypted, keyId: 'kek-v999' })).toThrow(/keyId/);
  });

  it('uses a fresh IV for each call', () => {
    const a = cipher.encrypt('same');
    const b = cipher.encrypt('same');
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });
});
