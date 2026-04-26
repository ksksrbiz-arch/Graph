// OAuth2 provider descriptor. Concrete connectors register one of these so
// OAuthService can drive the same authorize → callback → refresh flow against
// every upstream — only the URLs, scopes, and (occasionally) the body shape
// differ. PKCE + state are handled in OAuthService; providers stay declarative.

import type { ConnectorId } from '@pkg/shared';

export interface OAuthTokenResponse {
  accessToken: string;
  /** Some providers (GitHub, Notion) don't issue refresh tokens. */
  refreshToken?: string;
  /** Seconds-from-now until the access token expires. */
  expiresInSeconds?: number;
  /** Scopes the user actually granted, if reported. */
  grantedScopes?: string[];
  /** Anything else the provider sent — kept for connector-specific use. */
  extra?: Record<string, unknown>;
}

export interface OAuthProvider {
  readonly connectorId: ConnectorId;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly defaultScopes: readonly string[];
  /** True when the provider implements the standard OAuth2 PKCE extension. */
  readonly supportsPkce: boolean;
  /** True when the provider issues refresh tokens that we should rotate. */
  readonly issuesRefreshToken: boolean;
  /** Build any extra params the authorize URL needs (e.g. Google's
   *  `access_type=offline`). Defaults are merged on top. */
  buildAuthorizeParams?(): Record<string, string>;
  /** Map the token endpoint's JSON body to our normalised shape. */
  parseTokenResponse(body: unknown): OAuthTokenResponse;
}
