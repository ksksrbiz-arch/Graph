// OAuth handshake foundation. Registers the provider catalogue, the in-memory
// state store, and the public-facing controller. The shared
// ConnectorConfigStore (where freshly-issued tokens are persisted) is
// supplied by the global ConnectorConfigsModule, so we don't have to import
// the concrete-connector module here.

import { Module } from '@nestjs/common';
import { OAuthController } from './oauth.controller';
import { OAuthService } from './oauth.service';
import { OAuthStateStore } from './oauth-state.store';
import { OAuthProviderRegistry } from './providers/registry';

@Module({
  controllers: [OAuthController],
  providers: [OAuthService, OAuthStateStore, OAuthProviderRegistry],
  exports: [OAuthService, OAuthProviderRegistry],
})
export class OAuthModule {}
