import { Injectable, NotFoundException } from '@nestjs/common';
import type { ConnectorId } from '@pkg/shared';
import { GITHUB_PROVIDER } from './github.provider';
import { GOOGLE_PROVIDER } from './google.provider';
import { NOTION_PROVIDER } from './notion.provider';
import type { OAuthProvider } from './oauth-provider';

@Injectable()
export class OAuthProviderRegistry {
  private readonly providers = new Map<ConnectorId, OAuthProvider>();

  constructor() {
    this.register(GITHUB_PROVIDER);
    this.register(GOOGLE_PROVIDER);
    this.register(NOTION_PROVIDER);
  }

  register(provider: OAuthProvider): void {
    this.providers.set(provider.connectorId, provider);
  }

  get(connectorId: ConnectorId): OAuthProvider {
    const p = this.providers.get(connectorId);
    if (!p) {
      throw new NotFoundException(
        `no OAuth provider registered for '${connectorId}'`,
      );
    }
    return p;
  }

  has(connectorId: ConnectorId): boolean {
    return this.providers.has(connectorId);
  }

  list(): readonly OAuthProvider[] {
    return [...this.providers.values()];
  }
}
