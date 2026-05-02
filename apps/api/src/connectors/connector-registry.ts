// Lookup table from ConnectorId to the BaseConnector instance that knows
// how to fetch + transform that source. The sync orchestrator uses this to
// resolve a connector at job time without hard-coding a switch.

import { Injectable, NotFoundException } from '@nestjs/common';
import type { ConnectorId } from '@pkg/shared';
import type { BaseConnector } from './base.connector';
import { AnthropicConnector } from './anthropic.connector';
import { GitHubConnector } from './github.connector';
import { GoogleCalendarConnector } from './google-calendar.connector';
import { NotionConnector } from './notion.connector';
import { OpenAIConnector } from './openai.connector';
import { PiecesConnector } from './pieces.connector';
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
  ) {
    this.byId.set(github.id, github);
    this.byId.set(googleCalendar.id, googleCalendar);
    this.byId.set(notion.id, notion);
    this.byId.set(zotero.id, zotero);
    this.byId.set(openai.id, openai);
    this.byId.set(anthropic.id, anthropic);
    this.byId.set(pieces.id, pieces);
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
