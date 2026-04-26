// Concrete connectors (GitHub, Google Calendar, Notion) plus the registry
// the sync orchestrator uses to look them up by id. The shared
// ConnectorConfigStore is provided globally by ConnectorConfigsModule so we
// don't have to import OAuthModule here (avoids a circular dep — OAuth needs
// to write configs, connectors need OAuthService to refresh tokens).

import { Module, forwardRef } from '@nestjs/common';
import { OAuthModule } from '../oauth/oauth.module';
import { SyncModule } from '../sync/sync.module';
import { ConnectorRegistry } from './connector-registry';
import { ConnectorsController } from './connectors.controller';
import { GitHubConnector } from './github.connector';
import { GoogleCalendarConnector } from './google-calendar.connector';
import { NotionConnector } from './notion.connector';

@Module({
  imports: [OAuthModule, forwardRef(() => SyncModule)],
  controllers: [ConnectorsController],
  providers: [
    GitHubConnector,
    GoogleCalendarConnector,
    NotionConnector,
    ConnectorRegistry,
  ],
  exports: [ConnectorRegistry],
})
export class ConnectorsModule {}
