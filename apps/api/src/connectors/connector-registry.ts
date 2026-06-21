// Lookup table from ConnectorId to the BaseConnector instance that knows
// how to fetch + transform that source. The sync orchestrator uses this to
// resolve a connector at job time without hard-coding a switch.

import { Injectable, NotFoundException } from '@nestjs/common';
import type { ConnectorId } from '@pkg/shared';
import type { BaseConnector } from './base.connector';
import { AnthropicConnector } from './anthropic.connector';
import { BookmarksConnector } from './bookmarks.connector';
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

@Injectable()
export class ConnectorRegistry {
  private readonly byId = new Map<ConnectorId, BaseConnector>();

  constructor(
    github: GitHubConnector,
    googleCalendar: GoogleCalendarConnector,
    notion: NotionConnector,
    zotero: ZoteroConnector,
    openai: OpenAIConnector,
    anthropic: AnthropicConnector,
    pieces: PiecesConnector,
    gmail: GmailConnector,
    outlook: OutlookConnector,
    todoist: TodoistConnector,
    linear: LinearConnector,
    gitlab: GitLabConnector,
    obsidian: ObsidianConnector,
    bookmarks: BookmarksConnector,
  ) {
    for (const c of [
      github,
      googleCalendar,
      notion,
      zotero,
      openai,
      anthropic,
      pieces,
      gmail,
      outlook,
      todoist,
      linear,
      gitlab,
      obsidian,
      bookmarks,
    ]) {
      this.byId.set(c.id, c);
    }
  }

  get(id: ConnectorId): BaseConnector {
    const c = this.byId.get(id);
    if (!c) {
      throw new NotFoundException(`no connector implementation for '${id}'`);
    }
    return c;
  }

  has(id: ConnectorId): boolean {
    return this.byId.has(id);
  }

  ids(): ConnectorId[] {
    return [...this.byId.keys()];
  }
}
