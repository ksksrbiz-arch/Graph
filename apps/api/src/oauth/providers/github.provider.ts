// GitHub OAuth Apps. PKCE is *not* supported (yet) by github.com — we rely on
// the encrypted state nonce alone for CSRF protection. GitHub OAuth Apps do
// not issue refresh tokens; access tokens are long-lived until revoked.
//
// Docs: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps

import type { OAuthProvider, OAuthTokenResponse } from './oauth-provider';

export const GITHUB_PROVIDER: OAuthProvider = {
  connectorId: 'github',
  authorizeUrl: 'https://github.com/login/oauth/authorize',
  tokenUrl: 'https://github.com/login/oauth/access_token',
  // Read-only scopes: list repos, read commits/issues/PRs the user can see.
  defaultScopes: ['read:user', 'repo'],
  supportsPkce: false,
  issuesRefreshToken: false,
  parseTokenResponse(body: unknown): OAuthTokenResponse {
    const o = (body ?? {}) as Record<string, unknown>;
    if (typeof o.access_token !== 'string') {
      throw new Error('github: token endpoint did not return access_token');
    }
    return {
      accessToken: o.access_token,
      ...(typeof o.scope === 'string'
        ? { grantedScopes: o.scope.split(',').filter(Boolean) }
        : {}),
      extra: { tokenType: o.token_type },
    };
  },
};
