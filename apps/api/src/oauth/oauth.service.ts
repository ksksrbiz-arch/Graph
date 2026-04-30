// OAuth orchestration. Three responsibilities:
//
//   1. Build an authorization URL that the SPA opens in a popup / redirect
//      (with state, optional PKCE, and the provider's extra params).
//   2. Handle the callback: trade `code` for tokens, encrypt them with the
//      shared CredentialCipher, and persist them as a ConnectorConfig.
//   3. Refresh tokens for providers that issue refresh tokens (Google).
//
// Phase 0 stores ConnectorConfig in memory (see ConnectorConfigStore) — Phase 1
// swaps that for the Postgres-backed `connector_configs` table from
// infra/postgres/init/001-schema.sql. The interface stays the same.

import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import {
  DEFAULT_CONNECTOR_SYNC_INTERVAL_MINUTES,
  type ConnectorId,
  type ConnectorConfig,
} from '@pkg/shared';
import { CredentialCipher } from '../shared/crypto/credential-cipher';
import { ConnectorConfigStore } from '../connectors/connector-config.store';
import { loadEnv } from '../config/env';
import { OAuthStateStore, type OAuthState } from './oauth-state.store';
import { OAuthProviderRegistry } from './providers/registry';
import type {
  OAuthProvider,
  OAuthTokenResponse,
} from './providers/oauth-provider';

export interface AuthorizeRequest {
  userId: string;
  connectorId: ConnectorId;
  /** Absolute redirect URI registered with the provider — usually our own
   *  `/oauth/callback/:connectorId` route. */
  redirectUri: string;
  /** Optional override scopes; defaults to the provider's `defaultScopes`. */
  scopes?: readonly string[];
  /** Where the SPA should land after we finish the handshake. */
  returnTo?: string;
}

export interface AuthorizeResult {
  authorizeUrl: string;
  state: string;
}

export interface CallbackRequest {
  connectorId: ConnectorId;
  code: string;
  state: string;
  /** Derived callback URI from inbound request (kept for diagnostics). */
  redirectUri: string;
}

interface CredentialPayload {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  grantedScopes?: string[];
  extra?: Record<string, unknown>;
}

@Injectable()
export class OAuthService {
  private readonly log = new Logger(OAuthService.name);

  constructor(
    private readonly registry: OAuthProviderRegistry,
    private readonly state: OAuthStateStore,
    private readonly cipher: CredentialCipher,
    private readonly configs: ConnectorConfigStore,
  ) {}

  authorize(req: AuthorizeRequest): AuthorizeResult {
    const provider = this.registry.get(req.connectorId);
    const credentials = this.providerCredentials(req.connectorId);
    const scopes = req.scopes ?? provider.defaultScopes;
    const state = randomBytes(32).toString('base64url');

    const stateEntry: OAuthState = {
      state,
      userId: req.userId,
      connectorId: req.connectorId,
      redirectUri: req.redirectUri,
      createdAt: Date.now(),
      ...(req.returnTo ? { returnTo: req.returnTo } : {}),
    };

    const params = new URLSearchParams({
      client_id: credentials.clientId,
      redirect_uri: req.redirectUri,
      response_type: 'code',
      state,
    });
    if (scopes.length > 0) params.set('scope', scopes.join(' '));

    if (provider.supportsPkce) {
      const verifier = randomBytes(48).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      params.set('code_challenge', challenge);
      params.set('code_challenge_method', 'S256');
      stateEntry.codeVerifier = verifier;
    }

    if (provider.buildAuthorizeParams) {
      for (const [k, v] of Object.entries(provider.buildAuthorizeParams())) {
        params.set(k, v);
      }
    }

    this.state.put(stateEntry);

    const url = `${provider.authorizeUrl}?${params.toString()}`;
    this.log.log(
      `oauth authorize user=${req.userId} connector=${req.connectorId}`,
    );
    return { authorizeUrl: url, state };
  }

  async handleCallback(req: CallbackRequest): Promise<ConnectorConfig> {
    const provider = this.registry.get(req.connectorId);
    const entry = this.state.take(req.state);
    if (!entry) {
      throw new UnauthorizedException('invalid or expired oauth state');
    }
    if (entry.connectorId !== req.connectorId) {
      throw new BadRequestException(
        `state/connector mismatch: ${entry.connectorId} vs ${req.connectorId}`,
      );
    }
    if (req.redirectUri !== entry.redirectUri) {
      this.log.warn(
        `oauth callback redirect_uri mismatch connector=${req.connectorId}: ` +
          `callback=${req.redirectUri} authorize=${entry.redirectUri}`,
      );
    }

    const tokens = await this.exchangeCode({
      provider,
      code: req.code,
      redirectUri: entry.redirectUri,
      ...(entry.codeVerifier ? { codeVerifier: entry.codeVerifier } : {}),
    });

    const payload = this.toPayload(tokens);
    const credentials = this.cipher.encrypt(JSON.stringify(payload));

    const existing = this.configs.find(entry.userId, req.connectorId);
    const config: ConnectorConfig = {
      id: req.connectorId,
      userId: entry.userId,
      enabled: true,
      credentials,
      syncIntervalMinutes:
        existing?.syncIntervalMinutes ?? DEFAULT_CONNECTOR_SYNC_INTERVAL_MINUTES,
    };
    this.configs.upsert(config);
    this.log.log(
      `oauth callback ok user=${entry.userId} connector=${req.connectorId}` +
        (tokens.expiresInSeconds
          ? ` (expires in ${tokens.expiresInSeconds}s)`
          : ''),
    );
    return config;
  }

  /** Decrypt the stored credentials payload. */
  decryptCredentials(config: ConnectorConfig): CredentialPayload {
    const json = this.cipher.decrypt(config.credentials);
    return JSON.parse(json) as CredentialPayload;
  }

  /** Refresh an expired access token, persist the new payload, and return it.
   *  Throws if the provider doesn't issue refresh tokens or none was stored. */
  async refresh(config: ConnectorConfig): Promise<CredentialPayload> {
    const provider = this.registry.get(config.id);
    if (!provider.issuesRefreshToken) {
      throw new Error(`${config.id} does not support token refresh`);
    }
    const current = this.decryptCredentials(config);
    if (!current.refreshToken) {
      throw new Error(`${config.id}: no refresh token stored`);
    }
    const credentials = this.providerCredentials(config.id);

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: current.refreshToken,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
    });

    const res = await fetch(provider.tokenUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
    if (!res.ok) {
      throw new Error(
        `oauth refresh failed connector=${config.id} status=${res.status}`,
      );
    }
    const tokens = provider.parseTokenResponse(await res.json());
    // Some providers (Google) don't return a fresh refresh_token on every
    // refresh — keep the old one when missing.
    const merged: CredentialPayload = {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? current.refreshToken,
      ...(tokens.expiresInSeconds !== undefined
        ? { expiresAt: this.expiresAt(tokens.expiresInSeconds) }
        : {}),
      ...(tokens.grantedScopes
        ? { grantedScopes: tokens.grantedScopes }
        : current.grantedScopes
          ? { grantedScopes: current.grantedScopes }
          : {}),
      ...(tokens.extra ? { extra: tokens.extra } : current.extra ? { extra: current.extra } : {}),
    };
    const encrypted = this.cipher.encrypt(JSON.stringify(merged));
    this.configs.upsert({ ...config, credentials: encrypted });
    return merged;
  }

  // ── internals ──

  private async exchangeCode(args: {
    provider: OAuthProvider;
    code: string;
    redirectUri: string;
    codeVerifier?: string;
  }): Promise<OAuthTokenResponse> {
    const credentials = this.providerCredentials(args.provider.connectorId);
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: args.code,
      redirect_uri: args.redirectUri,
    });

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    };

    // Notion requires Basic auth on the token endpoint; everyone else takes
    // client credentials in the body.
    const tokenAuth = (args.provider as { tokenAuth?: 'basic' }).tokenAuth;
    if (tokenAuth === 'basic') {
      const basic = Buffer.from(
        `${credentials.clientId}:${credentials.clientSecret}`,
      ).toString('base64');
      headers.Authorization = `Basic ${basic}`;
    } else {
      body.set('client_id', credentials.clientId);
      body.set('client_secret', credentials.clientSecret);
    }

    if (args.codeVerifier) body.set('code_verifier', args.codeVerifier);

    const res = await fetch(args.provider.tokenUrl, {
      method: 'POST',
      headers,
      body: body.toString(),
    });
    const json = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) {
      const detail =
        json && typeof json === 'object'
          ? JSON.stringify(json)
          : `HTTP ${res.status}`;
      throw new BadRequestException(
        `oauth token exchange failed connector=${args.provider.connectorId}: ${detail}`,
      );
    }
    return args.provider.parseTokenResponse(json);
  }

  private toPayload(tokens: OAuthTokenResponse): CredentialPayload {
    return {
      accessToken: tokens.accessToken,
      ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
      ...(tokens.expiresInSeconds !== undefined
        ? { expiresAt: this.expiresAt(tokens.expiresInSeconds) }
        : {}),
      ...(tokens.grantedScopes ? { grantedScopes: tokens.grantedScopes } : {}),
      ...(tokens.extra ? { extra: tokens.extra } : {}),
    };
  }

  private expiresAt(secondsFromNow: number): string {
    return new Date(Date.now() + secondsFromNow * 1000).toISOString();
  }

  private providerCredentials(connectorId: ConnectorId): {
    clientId: string;
    clientSecret: string;
  } {
    const env = loadEnv();
    const map: Partial<
      Record<ConnectorId, { id?: string; secret?: string }>
    > = {
      github: {
        id: env.GITHUB_OAUTH_CLIENT_ID,
        secret: env.GITHUB_OAUTH_CLIENT_SECRET,
      },
      google_calendar: {
        id: env.GOOGLE_OAUTH_CLIENT_ID,
        secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      },
      notion: {
        id: env.NOTION_OAUTH_CLIENT_ID,
        secret: env.NOTION_OAUTH_CLIENT_SECRET,
      },
    };
    const found = map[connectorId];
    if (!found?.id || !found?.secret) {
      throw new BadRequestException(
        `oauth client credentials not configured for ${connectorId}`,
      );
    }
    return { clientId: found.id, clientSecret: found.secret };
  }
}
