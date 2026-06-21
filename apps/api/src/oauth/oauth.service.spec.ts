// Behaviour tests for OAuthService.authorize() and the Postgres-backed
// OAuthStateStore. The store talks to `pg.Pool`, which we replace with a small
// in-memory fake (NO real Postgres) that emulates the table semantics the SQL
// relies on: upsert on `state`, single-use DELETE ... RETURNING, and
// expires_at-based pruning. PKCE + state plumbing is asserted here; the
// callback / refresh paths that hit the provider over fetch are covered with
// the fetch mock below.

import type { Pool, QueryResult, QueryResultRow } from 'pg';
import { ConnectorConfigStore } from '../connectors/connector-config.store';
import { resetEnvCache } from '../config/env';
import { OAuthService } from './oauth.service';
import { OAuthStateStore } from './oauth-state.store';
import { OAuthProviderRegistry } from './providers/registry';
import { CredentialCipher } from '../shared/crypto/credential-cipher';

const KEK = Buffer.alloc(32, 1).toString('base64');

interface StateRow {
  state: string;
  user_id: string;
  connector_id: string;
  redirect_uri: string;
  code_verifier: string | null;
  return_to: string | null;
  created_at: Date;
  expires_at: Date;
}

/**
 * Minimal in-memory stand-in for `pg.Pool` covering exactly the four queries
 * the OAuthStateStore issues. Dispatches on SQL keywords rather than exact
 * text so harmless formatting changes don't break the tests.
 */
class FakePool {
  readonly rows = new Map<string, StateRow>();
  readonly queries: string[] = [];

  query = jest.fn(
    async <T extends QueryResultRow>(
      sql: string,
      params: unknown[] = [],
    ): Promise<QueryResult<T>> => {
      this.queries.push(sql);
      const text = sql.trim().toUpperCase();

      if (text.startsWith('INSERT INTO OAUTH_STATES')) {
        const [
          state,
          userId,
          connectorId,
          redirectUri,
          codeVerifier,
          returnTo,
          createdAt,
          expiresAt,
        ] = params as [
          string,
          string,
          string,
          string,
          string | null,
          string | null,
          Date,
          Date,
        ];
        this.rows.set(state, {
          state,
          user_id: userId,
          connector_id: connectorId,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
          return_to: returnTo,
          created_at: createdAt,
          expires_at: expiresAt,
        });
        return this.result<T>([]);
      }

      if (text.startsWith('DELETE FROM OAUTH_STATES WHERE STATE')) {
        const [state] = params as [string];
        const row = this.rows.get(state);
        if (row) this.rows.delete(state);
        return this.result<T>(row ? [row as unknown as T] : []);
      }

      if (text.startsWith('DELETE FROM OAUTH_STATES WHERE EXPIRES_AT')) {
        const now = Date.now();
        for (const [k, v] of this.rows) {
          if (v.expires_at.getTime() <= now) this.rows.delete(k);
        }
        return this.result<T>([]);
      }

      if (text.startsWith('DELETE FROM OAUTH_STATES')) {
        this.rows.clear();
        return this.result<T>([]);
      }

      throw new Error(`FakePool: unexpected query: ${sql}`);
    },
  );

  private result<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
    return {
      rows,
      rowCount: rows.length,
      command: '',
      oid: 0,
      fields: [],
    };
  }
}

function makeService(): {
  service: OAuthService;
  state: OAuthStateStore;
  configs: ConnectorConfigStore;
  pool: FakePool;
} {
  process.env.GITHUB_OAUTH_CLIENT_ID = 'gh-id';
  process.env.GITHUB_OAUTH_CLIENT_SECRET = 'gh-secret';
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'g-id';
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'g-secret';
  process.env.KEK_BASE64 = KEK;
  process.env.JWT_SECRET = 'a'.repeat(32);
  process.env.POSTGRES_URL = 'postgres://u:p@localhost:5432/db';
  process.env.NEO4J_URI = 'bolt://localhost:7687';
  process.env.NEO4J_USER = 'neo4j';
  process.env.NEO4J_PASSWORD = 'neo4j';
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.MEILI_HOST = 'http://localhost:7700';
  process.env.MEILI_MASTER_KEY = 'm';

  // Reset the module-level env cache so the new vars are picked up.
  resetEnvCache();

  const registry = new OAuthProviderRegistry();
  const pool = new FakePool();
  const state = new OAuthStateStore(pool as unknown as Pool);
  const cipher = new CredentialCipher();
  const configs = new ConnectorConfigStore();
  return {
    service: new OAuthService(registry, state, cipher, configs),
    state,
    configs,
    pool,
  };
}

describe('OAuthService.authorize', () => {
  it('builds a GitHub authorize URL with state but no PKCE', async () => {
    const { service, state } = makeService();
    const result = await service.authorize({
      userId: 'u1',
      connectorId: 'github',
      redirectUri: 'http://localhost:3001/api/v1/oauth/callback/github',
    });
    const url = new URL(result.authorizeUrl);
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('gh-id');
    expect(url.searchParams.get('state')).toBe(result.state);
    expect(url.searchParams.get('code_challenge')).toBeNull();

    const stored = await state.take(result.state);
    expect(stored?.userId).toBe('u1');
    expect(stored?.codeVerifier).toBeUndefined();
  });

  it('attaches PKCE for Google + access_type=offline', async () => {
    const { service, state } = makeService();
    const result = await service.authorize({
      userId: 'u2',
      connectorId: 'google_calendar',
      redirectUri: 'http://localhost:3001/cb',
    });
    const url = new URL(result.authorizeUrl);
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');

    const stored = await state.take(result.state);
    expect(stored?.codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('persists returnTo and the exact authorize redirect_uri', async () => {
    const { service, state } = makeService();
    const result = await service.authorize({
      userId: 'u3',
      connectorId: 'github',
      redirectUri: 'http://localhost:3001/cb-exact',
      returnTo: '/connectors',
    });
    const stored = await state.take(result.state);
    expect(stored?.returnTo).toBe('/connectors');
    expect(stored?.redirectUri).toBe('http://localhost:3001/cb-exact');
    expect(stored?.connectorId).toBe('github');
  });

  it('refuses to start a flow when client credentials are not set', async () => {
    delete process.env.NOTION_OAUTH_CLIENT_ID;
    delete process.env.NOTION_OAUTH_CLIENT_SECRET;
    const { service } = makeService();
    await expect(
      service.authorize({
        userId: 'u',
        connectorId: 'notion',
        redirectUri: 'http://localhost:3001/cb',
      }),
    ).rejects.toThrow(/notion/i);
  });
});

describe('OAuthStateStore', () => {
  it('take() is single-use: a second read returns undefined', async () => {
    const { state } = makeService();
    await state.put({
      state: 's1',
      userId: 'u',
      connectorId: 'github',
      redirectUri: 'http://localhost/cb',
      createdAt: Date.now(),
    });
    expect((await state.take('s1'))?.userId).toBe('u');
    expect(await state.take('s1')).toBeUndefined();
  });

  it('take() treats an expired row as missing and deletes it', async () => {
    const { state } = makeService();
    // createdAt far in the past so expires_at (createdAt + TTL) is already past.
    await state.put({
      state: 's2',
      userId: 'u',
      connectorId: 'github',
      redirectUri: 'http://localhost/cb',
      createdAt: Date.now() - 60 * 60_000,
    });
    expect(await state.take('s2')).toBeUndefined();
  });

  it('prune() removes only expired rows', async () => {
    const { state, pool } = makeService();
    await state.put({
      state: 'fresh',
      userId: 'u',
      connectorId: 'github',
      redirectUri: 'http://localhost/cb',
      createdAt: Date.now(),
    });
    await state.put({
      state: 'stale',
      userId: 'u',
      connectorId: 'github',
      redirectUri: 'http://localhost/cb',
      createdAt: Date.now() - 60 * 60_000,
    });
    await state.prune();
    expect(pool.rows.has('fresh')).toBe(true);
    expect(pool.rows.has('stale')).toBe(false);
  });
});

describe('OAuthService.handleCallback', () => {
  it('reuses authorize-time redirect_uri during code exchange', async () => {
    const { service } = makeService();
    const authorizeRedirectUri =
      'http://localhost:3001/api/v1/oauth/callback/github';
    const result = await service.authorize({
      userId: 'u1',
      connectorId: 'github',
      redirectUri: authorizeRedirectUri,
    });

    const originalFetch = global.fetch;
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'gh-token',
        scope: 'read:user,repo',
        token_type: 'bearer',
      }),
    });
    (global as { fetch: typeof fetch }).fetch = fetchMock as typeof fetch;

    try {
      await service.handleCallback({
        connectorId: 'github',
        code: 'code-123',
        state: result.state,
        redirectUri: 'http://127.0.0.1:3001/api/v1/oauth/callback/github',
      });
    } finally {
      (global as { fetch: typeof fetch }).fetch = originalFetch;
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, req] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = new URLSearchParams(String(req.body));
    expect(body.get('redirect_uri')).toBe(authorizeRedirectUri);
  });

  it('rejects an unknown/consumed state as a CSRF failure', async () => {
    const { service } = makeService();
    await expect(
      service.handleCallback({
        connectorId: 'github',
        code: 'code-123',
        state: 'never-issued',
        redirectUri: 'http://localhost:3001/api/v1/oauth/callback/github',
      }),
    ).rejects.toThrow(/invalid or expired oauth state/i);
  });
});
