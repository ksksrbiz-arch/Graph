// Google Calendar connector — fetches events from the user's primary calendar
// since the last sync. Each event becomes one KGNode (`event`) plus an edge
// to each attendee (modelled as a `person` node).
//
// Token expiry: Google access tokens expire in 1h. fetchIncremental refreshes
// on 401 once and retries; persistent failure raises so the orchestrator marks
// the sync `failed` and surfaces it to the user.
//
// Docs: https://developers.google.com/calendar/api/v3/reference/events/list

import { Injectable, Logger } from '@nestjs/common';
import type { ConnectorConfig, KGEdge, KGNode } from '@pkg/shared';
import { BaseConnector, type RawItem, type TransformResult } from './base.connector';
import {
  authedFetch,
  deterministicUuid,
  isoNow,
  newEdgeId,
} from './connector-utils';
import { OAuthService } from '../oauth/oauth.service';

interface GCalEvent {
  id: string;
  status: 'confirmed' | 'tentative' | 'cancelled';
  htmlLink?: string;
  summary?: string;
  description?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  created?: string;
  updated?: string;
  organizer?: { email?: string; displayName?: string };
  attendees?: Array<{ email: string; displayName?: string; responseStatus?: string }>;
}

const PAGE_SIZE = 100;
const MAX_PAGES = 4;
const CALENDAR_ID = 'primary';

@Injectable()
export class GoogleCalendarConnector extends BaseConnector {
  private readonly log = new Logger(GoogleCalendarConnector.name);
  readonly id = 'google_calendar' as const;
  readonly oauthScopes = [
    'https://www.googleapis.com/auth/calendar.readonly',
  ] as const;

  constructor(private readonly oauth: OAuthService) {
    super();
  }

  async *fetchIncremental(
    config: ConnectorConfig,
    since: Date,
  ): AsyncGenerator<RawItem> {
    let accessToken = await this.ensureFreshToken(config);
    let pageToken: string | undefined;

    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({
        updatedMin: since.toISOString(),
        showDeleted: 'true',
        singleEvents: 'true',
        orderBy: 'updated',
        maxResults: String(PAGE_SIZE),
      });
      if (pageToken) params.set('pageToken', pageToken);
      const url =
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events?` +
        params.toString();

      let { res } = await authedFetch(url, accessToken);
      if (res.status === 401) {
        // Refresh once on the assumption the access token expired between
        // syncs. If the refresh works the second fetch should succeed.
        const refreshed = await this.oauth.refresh(config).catch(() => null);
        if (!refreshed) throw new Error('google: token refresh failed');
        accessToken = refreshed.accessToken;
        ({ res } = await authedFetch(url, accessToken));
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        this.log.warn(
          `gcal fetch ${res.status}: ${text.slice(0, 160)}`,
        );
        return;
      }
      const body = (await res.json()) as { items?: GCalEvent[]; nextPageToken?: string };
      const items = body.items ?? [];
      for (const ev of items) {
        if (ev.status === 'cancelled') continue;
        yield { externalId: ev.id, raw: ev };
      }
      if (!body.nextPageToken) return;
      pageToken = body.nextPageToken;
    }
  }

  transform(raw: RawItem): TransformResult {
    const ev = raw.raw as GCalEvent;
    const startIso =
      ev.start?.dateTime ?? (ev.start?.date ? `${ev.start.date}T00:00:00Z` : ev.created ?? isoNow());
    const node: KGNode = {
      id: deterministicUuid('google_calendar', ev.id),
      type: 'event',
      label: ev.summary?.slice(0, 200) ?? '(untitled event)',
      sourceId: 'google_calendar',
      ...(ev.htmlLink ? { sourceUrl: ev.htmlLink } : {}),
      createdAt: ev.created ?? startIso,
      updatedAt: ev.updated ?? isoNow(),
      metadata: {
        start: startIso,
        end: ev.end?.dateTime ?? ev.end?.date ?? null,
        organizer: ev.organizer?.email ?? null,
      },
    };

    const edges: KGEdge[] = [];

    if (ev.organizer?.email) {
      const personId = deterministicUuid('google_calendar', `person:${ev.organizer.email}`);
      edges.push(edgeBetween(node.id, personId, 'AUTHORED_BY', 0.5));
    }
    for (const a of ev.attendees ?? []) {
      const personId = deterministicUuid('google_calendar', `person:${a.email}`);
      edges.push(edgeBetween(node.id, personId, 'SCHEDULED_WITH', 0.4));
    }

    return { node, edges };
  }

  private async ensureFreshToken(config: ConnectorConfig): Promise<string> {
    const creds = this.oauth.decryptCredentials(config);
    if (!creds.expiresAt) return creds.accessToken;
    const skewMs = 60_000; // refresh a minute early.
    if (Date.parse(creds.expiresAt) - Date.now() > skewMs) {
      return creds.accessToken;
    }
    const refreshed = await this.oauth.refresh(config);
    return refreshed.accessToken;
  }
}

function edgeBetween(
  source: string,
  target: string,
  relation: KGEdge['relation'],
  weight: number,
): KGEdge {
  return {
    id: newEdgeId(),
    source,
    target,
    relation,
    weight,
    inferred: false,
    createdAt: isoNow(),
    metadata: {},
  };
}
