// Behaviour tests for OAuthService.authorize() — the part that doesn't hit
// the network. We assert PKCE + state plumbing here; callback / refresh paths
// hit the provider over fetch and are best covered with an integration test
// (Phase 1).

import { ConnectorConfigStore } from '../connectors/connector-config.store';
import { resetEnvCache } from '../config/env';
import { OAuthService } from './oauth.service';
import { OAuthStateStore } from './oauth-state.store';
import { OAuthProviderRegistry } from './providers/registry';
import { CredentialCipher } from '../shared/crypto/credential-cipher';

const KEK = Buffer.alloc(32, 1).toString('base64');

function makeService(): {
  service: OAuthService;
  state: OAuthStateStore;
  configs: ConnectorConfigStore;
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
  const state = new OAuthStateStore();
  const cipher = new CredentialCipher();
  const configs = new ConnectorConfigStore();
  return {
    service: new OAuthService(registry, state, cipher, configs),
    state,
    configs,
  };
}

describe('OAuthService.authorize', () => {
  it('builds a GitHub authorize URL with state but no PKCE', () => {
    const { service, state } = makeService();
    const result = service.authorize({
      userId: 'u1',
      connectorId: 'github',
      redirectUri: 'http://localhost:3001/api/v1/oauth/callback/github',
    });
    const url = new URL(result.authorizeUrl);
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('gh-id');
    expect(url.searchParams.get('state')).toBe(result.state);
    expect(url.searchParams.get('code_challenge')).toBeNull();

    const stored = state.take(result.state);
    expect(stored?.userId).toBe('u1');
    expect(stored?.codeVerifier).toBeUndefined();
  });

  it('attaches PKCE for Google + access_type=offline', () => {
    const { service, state } = makeService();
    const result = service.authorize({
      userId: 'u2',
      connectorId: 'google_calendar',
      redirectUri: 'http://localhost:3001/cb',
    });
    const url = new URL(result.authorizeUrl);
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');

    const stored = state.take(result.state);
    expect(stored?.codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('refuses to start a flow when client credentials are not set', () => {
    delete process.env.NOTION_OAUTH_CLIENT_ID;
    delete process.env.NOTION_OAUTH_CLIENT_SECRET;
    const { service } = makeService();
    expect(() =>
      service.authorize({
        userId: 'u',
        connectorId: 'notion',
        redirectUri: 'http://localhost:3001/cb',
      }),
    ).toThrow(/notion/i);
  });
});

describe('OAuthService.handleCallback', () => {
  it('reuses authorize-time redirect_uri during code exchange', async () => {
    const { service } = makeService();
    const authorizeRedirectUri =
      'http://localhost:3001/api/v1/oauth/callback/github';
    const result = service.authorize({
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
});
