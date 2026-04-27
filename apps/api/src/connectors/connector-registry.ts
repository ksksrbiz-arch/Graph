// Lookup table from ConnectorId to the BaseConnector instance that knows
// how to fetch + transform that source. The sync orchestrator uses this to
// resolve a connector at job time without hard-coding a switch.

import { Injectable, NotFoundException } from '@nestjs/common';
import type { ConnectorId } from '@pkg/shared';
import type { BaseConnector } from './base.connector';
import { GitHubConnector } from './github.connector';
import { GoogleCalendarConnector } from './google-calendar.connector';
import { NotionConnector } from './notion.connector';
import { ZoteroConnector } from './zotero.connector';

@Injectable()
export class ConnectorRegistry {
  private readonly byId = new Map<ConnectorId, BaseConnector>();

  constructor(
    github: GitHubConnector,
    googleCalendar: GoogleCalendarConnector,
    notion: NotionConnector,
    zotero: ZoteroConnector,
  ) {
    this.byId.set(github.id, github);
    this.byId.set(googleCalendar.id, googleCalendar);
    this.byId.set(notion.id, notion);
    this.byId.set(zotero.id, zotero);
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
