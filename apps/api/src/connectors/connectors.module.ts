// Concrete connectors (GitHub, Google Calendar, Notion) plus the registry
// the sync orchestrator uses to look them up by id. The shared
// ConnectorConfigStore is provided globally by ConnectorConfigsModule so we
// don't have to import OAuthModule here (avoids a circular dep — OAuth needs
// to write configs, connectors need OAuthService to refresh tokens).

import { Module, forwardRef } from '@nestjs/common';
import { OAuthModule } from '../oauth/oauth.module';
import { SyncModule } from '../sync/sync.module';
import { AnthropicConnector } from './anthropic.connector';
import { BookmarksConnector } from './bookmarks.connector';
import { ConnectorRegistry } from './connector-registry';
import { ConnectorsController } from './connectors.controller';
import { GitHubConnector } from './github.connector';
import { GitLabConnector } from './gitlab.connector';
import { GmailConnector } from './gmail.connector';
import { GoogleCalendarConnector } from './google-calendar.connector';
import { LinearConnector } from './linear.connector';
import { NotionConnector } from './notion.connector';
import { ObsidianConnector } from './obsidian.connector';
import { OpenAIConnector } from './openai.connector';
import { OutlookConnector } from './outlook.connector';
import { PiecesConnector } from './pieces.connector';
import { TodoistConnector } from './todoist.connector';
import { ZoteroConnector } from './zotero.connector';

@Module({
  imports: [OAuthModule, forwardRef(() => SyncModule)],
  controllers: [ConnectorsController],
  providers: [
    GitHubConnector,
    GoogleCalendarConnector,
    NotionConnector,
    ZoteroConnector,
    OpenAIConnector,
    AnthropicConnector,
    PiecesConnector,
    GmailConnector,
    OutlookConnector,
    TodoistConnector,
    LinearConnector,
    GitLabConnector,
    ObsidianConnector,
    BookmarksConnector,
    ConnectorRegistry,
  ],
  exports: [ConnectorRegistry],
})
export class ConnectorsModule {}
