// Outlook (Microsoft 365) mail connector — incrementally syncs the
// authenticated user's Inbox via the Microsoft Graph **message delta** API.
// Each upstream message becomes one KGNode (`type: 'email'`, label = subject,
// sourceUrl = webLink) plus a small bundle of person edges (AUTHORED_BY for the
// sender, MENTIONS for each recipient).
//
// Cursor (delta token): Graph returns `@odata.nextLink` (more pages this round)
// or `@odata.deltaLink` (round complete). We persist the final deltaLink on the
// ConnectorConfig credentials (`extra.deltaLink`) so the next sync only pulls
// changes since then — the classic delta-query cursor. The first sync (no
// stored deltaLink) does an initial delta round filtered by `since`.
//   Docs: https://learn.microsoft.com/graph/delta-query-messages
//
// Token expiry (mirrors GoogleCalendarConnector): Microsoft access tokens
// expire in ~1h. We refresh proactively before the first request and once more
// on a 401, then retry; persistent failure raises so the orchestrator marks the
// sync failed.
//
// Idempotency (Rule 12): node ids are derived deterministically from the Graph
// message id via `deterministicUuid`, so re-syncs MERGE rather than insert.

import { Injectable, Logger } from '@nestjs/common';
import type {
  ConnectorConfig,
  ConnectorId,
  EncryptedCredentials,
  KGEdge,
  KGNode,
  NodeType,
} from '@pkg/shared';
import { BaseConnector, type RawItem, type TransformResult } from './base.connector';
import {
  authedFetch,
  deterministicUuid,
  isoNow,
  newEdgeId,
} from './connector-utils';
import { ConnectorConfigStore } from './connector-config.store';
import { CredentialCipher } from '../shared/crypto/credential-cipher';
import { OAuthService } from '../oauth/oauth.service';

// `outlook_mail` is the ConnectorId reserved in @pkg/shared for this source.
// Annotated (not cast) so a typo would be a compile error, while the value
// stays usable everywhere a ConnectorId is expected.
const CONNECTOR_ID: ConnectorId = 'outlook_mail';
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const PAGE_SIZE = 50;
const MAX_PAGES = 8; // up to 400 messages per round — keeps a poll polite.

interface GraphRecipient {
  emailAddress?: { name?: string; address?: string };
}

interface GraphMessage {
  id: string;
  subject?: string;
  webLink?: string;
  bodyPreview?: string;
  receivedDateTime?: string;
  sentDateTime?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  from?: GraphRecipient;
  sender?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  /** Present (with `'@removed': { reason }`) when the message was deleted. */
  '@removed'?: { reason?: string };
}

interface GraphDeltaResponse {
  value?: GraphMessage[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

interface OutlookCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  grantedScopes?: string[];
  extra?: Record<string, unknown>;
}

@Injectable()
export class OutlookConnector extends BaseConnector {
  private readonly log = new Logger(OutlookConnector.name);
  readonly id = CONNECTOR_ID;
  readonly oauthScopes = ['Mail.Read', 'offline_access'] as const;

  constructor(
    private readonly oauth: OAuthService,
    private readonly configs: ConnectorConfigStore,
    private readonly cipher: CredentialCipher,
  ) {
    super();
  }

  async *fetchIncremental(
    config: ConnectorConfig,
    since: Date,
  ): AsyncGenerator<RawItem> {
    let accessToken = await this.ensureFreshToken(config);
    const stored = this.readCredentials(config);

    // Resume from the persisted cursor when we have one; otherwise start a
    // fresh delta round scoped to `since` so the first sync isn't unbounded.
    // Graph encodes both the skipToken (more pages this round) and the
    // deltaToken (round complete) into opaque, resumable URLs, so a stashed
    // `@odata.nextLink` is just as valid a cursor as a `@odata.deltaLink`.
    let url = this.cursorOf(stored) ?? this.initialDeltaUrl(since);
    // Default the next cursor to the URL we are about to walk so that, even if
    // we bail mid-round (page cap, missing links), the cursor never regresses.
    let nextCursor: string | undefined = this.cursorOf(stored);

    for (let page = 0; page < MAX_PAGES; page++) {
      let { res } = await authedFetch(url, accessToken);
      if (res.status === 401) {
        const refreshed = await this.oauth.refresh(config).catch(() => null);
        if (!refreshed) throw new Error('outlook: token refresh failed');
        accessToken = refreshed.accessToken;
        ({ res } = await authedFetch(url, accessToken));
      }
      if (res.status === 401) {
        // Still unauthorized after a refresh — a persistent auth problem the
        // user must fix. Raise so the orchestrator marks the sync failed
        // rather than masking it as an empty success.
        throw new Error('outlook: unauthorized after token refresh');
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        this.log.warn(`outlook fetch ${res.status}: ${text.slice(0, 160)}`);
        break;
      }

      const body = (await res.json()) as GraphDeltaResponse;
      for (const msg of body.value ?? []) {
        // Skip tombstones — deletions arrive as `{ id, '@removed' }`.
        if (msg['@removed'] || !msg.id) continue;
        yield { externalId: msg.id, raw: msg };
      }

      const next = body['@odata.nextLink'];
      const delta = body['@odata.deltaLink'];
      // Advance the cursor to whichever resumable link this page returned. On
      // the final page that's the deltaLink; on the page-cap boundary it's the
      // last nextLink so the next sync continues mid-round instead of
      // re-walking from `since`.
      if (delta) {
        nextCursor = delta;
        break;
      }
      if (!next) break; // No links at all — keep the prior cursor.
      nextCursor = next;
      url = next;
    }

    // Persist the cursor so the next sync resumes from here. This is the
    // "cursor advance" — without it every sync would re-walk from `since`.
    this.persistCursor(config, nextCursor);
  }

  transform(raw: RawItem): TransformResult {
    const msg = raw.raw as GraphMessage;
    const sender = msg.from ?? msg.sender;
    const received =
      msg.receivedDateTime ?? msg.sentDateTime ?? msg.createdDateTime ?? isoNow();

    const to = addressesOf(msg.toRecipients);
    const cc = addressesOf(msg.ccRecipients);
    const type: NodeType = 'email';

    const node: KGNode = {
      id: deterministicUuid(CONNECTOR_ID, msg.id),
      type,
      label: (msg.subject?.trim() || '(no subject)').slice(0, 200),
      sourceId: CONNECTOR_ID,
      ...(msg.webLink ? { sourceUrl: msg.webLink } : {}),
      createdAt: received,
      updatedAt: msg.lastModifiedDateTime ?? isoNow(),
      metadata: {
        from: sender?.emailAddress?.address ?? null,
        fromName: sender?.emailAddress?.name ?? null,
        to,
        cc,
        received,
        preview: msg.bodyPreview?.slice(0, 280) ?? null,
      },
    };

    const edges: KGEdge[] = [];

    const senderAddr = sender?.emailAddress?.address?.toLowerCase();
    if (senderAddr) {
      const personId = deterministicUuid(CONNECTOR_ID, `person:${senderAddr}`);
      edges.push(edgeBetween(node.id, personId, 'AUTHORED_BY', 0.6));
    }

    // Recipients are "mentioned" by the message. Derive the edge set from the
    // same address lists used for metadata so node + edges never disagree, and
    // dedupe (case-insensitively) against the sender and across To/Cc.
    const seen = new Set<string>(senderAddr ? [senderAddr] : []);
    for (const addr of [...to, ...cc]) {
      const key = addr.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const personId = deterministicUuid(CONNECTOR_ID, `person:${key}`);
      edges.push(edgeBetween(node.id, personId, 'MENTIONS', 0.4));
    }

    return { node, edges };
  }

  // ── internals ──

  private initialDeltaUrl(since: Date): string {
    const params = new URLSearchParams({
      $select: 'subject,from,sender,toRecipients,ccRecipients,receivedDateTime,sentDateTime,bodyPreview,webLink,lastModifiedDateTime',
      $filter: `receivedDateTime ge ${since.toISOString()}`,
      $top: String(PAGE_SIZE),
    });
    return `${GRAPH_BASE}/me/mailFolders/Inbox/messages/delta?${params.toString()}`;
  }

  private cursorOf(creds: OutlookCredentials): string | undefined {
    const link = creds.extra?.deltaLink;
    return typeof link === 'string' && link.length > 0 ? link : undefined;
  }

  private readCredentials(config: ConnectorConfig): OutlookCredentials {
    return this.oauth.decryptCredentials(config) as OutlookCredentials;
  }

  private async ensureFreshToken(config: ConnectorConfig): Promise<string> {
    const creds = this.readCredentials(config);
    if (!creds.expiresAt) return creds.accessToken;
    const skewMs = 60_000; // refresh a minute early.
    if (Date.parse(creds.expiresAt) - Date.now() > skewMs) {
      return creds.accessToken;
    }
    // Proactive refresh is best-effort: if it fails (e.g. refresh wiring not
    // configured for this provider), fall back to the existing token and let
    // the 401 retry path handle a genuinely-expired credential.
    const refreshed = await this.oauth.refresh(config).catch(() => null);
    return refreshed?.accessToken ?? creds.accessToken;
  }

  /** Re-encrypt the credentials blob with the new cursor and upsert it so the
   *  next sync round resumes from here. No-op when nothing changed. */
  private persistCursor(
    config: ConnectorConfig,
    cursor: string | undefined,
  ): void {
    if (!cursor) return;
    // Re-read the freshest config (a 401 refresh may have rewritten the
    // credentials underneath us) before mutating its cursor.
    const current = this.configs.find(config.userId, config.id) ?? config;
    const creds = this.readCredentials(current);
    if (this.cursorOf(creds) === cursor) return; // already at this cursor.

    const updated: OutlookCredentials = {
      ...creds,
      extra: { ...(creds.extra ?? {}), deltaLink: cursor },
    };
    const encrypted: EncryptedCredentials = this.cipher.encrypt(
      JSON.stringify(updated),
    );
    this.configs.upsert({ ...current, credentials: encrypted });
  }
}

/** Pull the non-empty email addresses out of a Graph recipient list. */
function addressesOf(recipients: GraphRecipient[] | undefined): string[] {
  return (recipients ?? [])
    .map((r) => r.emailAddress?.address)
    .filter((a): a is string => Boolean(a));
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
