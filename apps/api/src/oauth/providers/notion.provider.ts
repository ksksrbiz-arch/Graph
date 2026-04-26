// Notion's "public integration" OAuth flow. Notion does not implement PKCE
// and does not currently issue refresh tokens — access tokens stay valid until
// the user revokes the integration. The token endpoint also requires a Basic
// Auth header (client_id:client_secret), which OAuthService applies when
// `tokenAuth` is `'basic'`.
//
// Docs: https://developers.notion.com/docs/authorization

import type { OAuthProvider, OAuthTokenResponse } from './oauth-provider';

export const NOTION_PROVIDER: OAuthProvider & { tokenAuth: 'basic' } = {
  connectorId: 'notion',
  authorizeUrl: 'https://api.notion.com/v1/oauth/authorize',
  tokenUrl: 'https://api.notion.com/v1/oauth/token',
  defaultScopes: [],
  supportsPkce: false,
  issuesRefreshToken: false,
  tokenAuth: 'basic',
  buildAuthorizeParams() {
    return { owner: 'user' };
  },
  parseTokenResponse(body: unknown): OAuthTokenResponse {
    const o = (body ?? {}) as Record<string, unknown>;
    if (typeof o.access_token !== 'string') {
      throw new Error('notion: token endpoint did not return access_token');
    }
    return {
      accessToken: o.access_token,
      extra: {
        botId: o.bot_id,
        workspaceId: o.workspace_id,
        workspaceName: o.workspace_name,
      },
    };
  },
};
