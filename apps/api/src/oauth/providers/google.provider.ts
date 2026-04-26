// Google OAuth (web flow) for Google Calendar read access.
// `access_type=offline` + `prompt=consent` is required to receive a refresh
// token on first consent; without it Google silently omits it on subsequent
// authorizations and our scheduler can't refresh expired access tokens.
//
// Docs: https://developers.google.com/identity/protocols/oauth2/web-server

import type { OAuthProvider, OAuthTokenResponse } from './oauth-provider';

export const GOOGLE_PROVIDER: OAuthProvider = {
  connectorId: 'google_calendar',
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  defaultScopes: [
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/calendar.events.readonly',
  ],
  supportsPkce: true,
  issuesRefreshToken: true,
  buildAuthorizeParams() {
    return {
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
    };
  },
  parseTokenResponse(body: unknown): OAuthTokenResponse {
    const o = (body ?? {}) as Record<string, unknown>;
    if (typeof o.access_token !== 'string') {
      throw new Error('google: token endpoint did not return access_token');
    }
    return {
      accessToken: o.access_token,
      ...(typeof o.refresh_token === 'string'
        ? { refreshToken: o.refresh_token }
        : {}),
      ...(typeof o.expires_in === 'number'
        ? { expiresInSeconds: o.expires_in }
        : {}),
      ...(typeof o.scope === 'string'
        ? { grantedScopes: o.scope.split(' ').filter(Boolean) }
        : {}),
    };
  },
};
