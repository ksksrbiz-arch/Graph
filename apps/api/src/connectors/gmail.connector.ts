// Gmail connector — fetches the authenticated user's recent mail and maps each
// message to an `email` KGNode plus a small bundle of edges (AUTHORED_BY for the
// sender, MENTIONS for each recipient). Each upstream message becomes one node.
//
// Incremental sync (Rule 12 / spec §9.1): Gmail exposes a per-mailbox
// `historyId` watermark. When we have one from a prior sync we ask
// `users.history.list?startHistoryId=…` for just the messages added since;
// otherwise (first sync) we fall back to a full `users.messages.list` bounded by
// `q=after:<epoch>` derived from `since`. Either path advances `lastHistoryId`
// to the newest watermark observed so the orchestrator can persist the cursor.
//
// Token expiry: Google access tokens last ~1h. fetchIncremental refreshes once
// on 401 and retries (mirrors the Google Calendar connector); a persistent
// failure raises so the orchestrator marks the sync failed.
//
// Rate limit (Rule 13): authedFetch() surfaces any rate-limit headers; we stop
// early when remaining is low so the orchestrator can back off.
//
// Idempotency (Rule 12): node ids are derived deterministically from the Gmail
// message id via `deterministicUuid`, so re-syncs MERGE rather than insert.
//
// Docs: https://developers.google.com/gmail/api/reference/rest/v1/users.messages

import { Injectable, Logger } from '@nestjs/common';
import type { ConnectorConfig, ConnectorId, KGEdge, KGNode } from '@pkg/shared';
import { BaseConnector, type RawItem, type TransformResult } from './base.connector';
import {
  authedFetch,
  deterministicUuid,
  isoNow,
  newEdgeId,
} from './connector-utils';
import { OAuthService } from '../oauth/oauth.service';

// `gmail` is a member of the shared CONNECTOR_IDS union, but we cast locally to
// stay decoupled from any wiring changes the coordinator makes at merge time.
const GMAIL_ID = 'gmail' as ConnectorId;

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const PAGE_SIZE = 50;
const MAX_PAGES = 4; // 200 messages per sync — keeps polling polite.

/** Shape of a single Gmail message in `format=metadata`. */
interface GmailMessage {
  id: string;
  threadId: string;
  historyId?: string;
  internalDate?: string; // epoch millis as a string
  snippet?: string;
  labelIds?: string[];
  payload?: {
    headers?: Array<{ name: string; value: string }>;
  };
}

interface GmailMessageRef {
  id: string;
  threadId: string;
}

interface MessagesListResponse {
  messages?: GmailMessageRef[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

interface HistoryListResponse {
  history?: Array<{
    id?: string;
    messagesAdded?: Array<{ message: GmailMessageRef }>;
  }>;
  nextPageToken?: string;
  historyId?: string;
}

/** A connector config may carry a Gmail `historyId` cursor stashed by a prior
 *  sync. ConnectorConfig itself doesn't model arbitrary cursors, so we read it
 *  defensively from an optional extension field. */
type ConfigWithCursor = ConnectorConfig & { historyId?: string };

@Injectable()
export class GmailConnector extends BaseConnector {
  private readonly log = new Logger(GmailConnector.name);
  readonly id = GMAIL_ID;
  readonly oauthScopes = [
    'https://www.googleapis.com/auth/gmail.readonly',
  ] as const;

  /** Newest mailbox `historyId` seen during the most recent fetch. The
   *  orchestrator persists this so the next sync can resume incrementally. */
  lastHistoryId?: string;

  /** Set when the Gmail quota runs low mid-sync; the hydration loop checks it
   *  and stops issuing further per-message calls so we back off (Rule 13). The
   *  cursor still advances to whatever was processed, so the next sync resumes. */
  private lowOnQuota = false;

  constructor(private readonly oauth: OAuthService) {
    super();
  }

  async *fetchIncremental(
    config: ConnectorConfig,
    since: Date,
  ): AsyncGenerator<RawItem> {
    let accessToken = await this.ensureFreshToken(config);
    const startHistoryId = (config as ConfigWithCursor).historyId;

    // Resolve the set of message refs to hydrate. With a prior historyId we ask
    // for just the delta; otherwise we list everything after `since`.
    const refs = startHistoryId
      ? await this.collectFromHistory(
          startHistoryId,
          () => accessToken,
          (t) => {
            accessToken = t;
          },
          config,
        )
      : await this.collectFromList(
          since,
          () => accessToken,
          (t) => {
            accessToken = t;
          },
          config,
        );

    this.lowOnQuota = false;
    for (const ref of refs) {
      const msg = await this.fetchMessage(
        ref.id,
        () => accessToken,
        (t) => {
          accessToken = t;
        },
        config,
      );
      if (!msg) continue;
      // Honor back-off: if the quota dipped low on the last call, stop here
      // (the cursor has advanced, so the next sync resumes from this point).
      if (this.lowOnQuota) {
        this.log.warn('gmail rate-limit low; backing off — remaining messages deferred to next sync');
        this.advanceCursor(msg.historyId);
        yield { externalId: msg.id, raw: { message: msg, observedAt: isoNow() } };
        break;
      }
      // Advance the cursor to the newest watermark we observe.
      this.advanceCursor(msg.historyId);
      yield {
        externalId: msg.id,
        raw: { message: msg, observedAt: isoNow() },
      };
    }
  }

  transform(raw: RawItem): TransformResult {
    const { message: msg } = raw.raw as { message: GmailMessage };
    const headers = indexHeaders(msg.payload?.headers ?? []);
    const subject = headers['subject'] ?? '(no subject)';
    const from = parseAddress(headers['from']);
    const recipients = [
      ...parseAddressList(headers['to']),
      ...parseAddressList(headers['cc']),
    ];
    const dateIso = internalDateToIso(msg.internalDate) ?? isoNow();

    const node: KGNode = {
      id: deterministicUuid(GMAIL_ID, msg.id),
      type: 'email',
      label: subject.slice(0, 200),
      sourceId: GMAIL_ID,
      // Gmail's stable web permalink uses the message id in the `#…` fragment.
      sourceUrl: `https://mail.google.com/mail/u/0/#inbox/${msg.id}`,
      createdAt: dateIso,
      updatedAt: isoNow(),
      metadata: {
        threadId: msg.threadId,
        from: from?.email ?? null,
        fromName: from?.name ?? null,
        to: recipients.map((r) => r.email),
        date: dateIso,
        snippet: msg.snippet ?? '',
        labels: msg.labelIds ?? [],
      },
    };

    const edges: KGEdge[] = [];
    if (from?.email) {
      const senderId = deterministicUuid(GMAIL_ID, `person:${from.email}`);
      edges.push(edgeBetween(node.id, senderId, 'AUTHORED_BY', 0.7));
    }
    const seen = new Set<string>();
    for (const r of recipients) {
      if (!r.email || seen.has(r.email)) continue;
      seen.add(r.email);
      const personId = deterministicUuid(GMAIL_ID, `person:${r.email}`);
      edges.push(edgeBetween(node.id, personId, 'MENTIONS', 0.4));
    }

    return { node, edges };
  }

  // ── internals ──

  /** Collect message refs added since `startHistoryId` via users.history.list. */
  private async collectFromHistory(
    startHistoryId: string,
    getToken: () => string,
    setToken: (t: string) => void,
    config: ConnectorConfig,
  ): Promise<GmailMessageRef[]> {
    const refs: GmailMessageRef[] = [];
    const seen = new Set<string>();
    let pageToken: string | undefined;

    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({
        startHistoryId,
        historyTypes: 'messageAdded',
        maxResults: String(PAGE_SIZE),
      });
      if (pageToken) params.set('pageToken', pageToken);
      const res = await this.authed(
        `${GMAIL_API}/history?${params.toString()}`,
        getToken,
        setToken,
        config,
      );
      if (!res) return refs;
      const body = (await res.json()) as HistoryListResponse;
      this.advanceCursor(body.historyId);
      for (const h of body.history ?? []) {
        this.advanceCursor(h.id);
        for (const added of h.messagesAdded ?? []) {
          const ref = added.message;
          if (ref && !seen.has(ref.id)) {
            seen.add(ref.id);
            refs.push(ref);
          }
        }
      }
      if (!body.nextPageToken) break;
      pageToken = body.nextPageToken;
    }
    return refs;
  }

  /** Full-list fallback: users.messages.list bounded by `q=after:<epoch>`. */
  private async collectFromList(
    since: Date,
    getToken: () => string,
    setToken: (t: string) => void,
    config: ConnectorConfig,
  ): Promise<GmailMessageRef[]> {
    const refs: GmailMessageRef[] = [];
    let pageToken: string | undefined;
    // Gmail's `after:` query operator takes epoch seconds.
    const afterEpoch = Math.floor(since.getTime() / 1000);

    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({ maxResults: String(PAGE_SIZE) });
      if (afterEpoch > 0) params.set('q', `after:${afterEpoch}`);
      if (pageToken) params.set('pageToken', pageToken);
      const res = await this.authed(
        `${GMAIL_API}/messages?${params.toString()}`,
        getToken,
        setToken,
        config,
      );
      if (!res) return refs;
      const body = (await res.json()) as MessagesListResponse;
      for (const ref of body.messages ?? []) refs.push(ref);
      if (!body.nextPageToken) break;
      pageToken = body.nextPageToken;
    }
    return refs;
  }

  private async fetchMessage(
    id: string,
    getToken: () => string,
    setToken: (t: string) => void,
    config: ConnectorConfig,
  ): Promise<GmailMessage | null> {
    const params = new URLSearchParams({ format: 'metadata' });
    // URLSearchParams collapses repeated keys, so append headers individually.
    for (const h of ['Subject', 'From', 'To', 'Cc', 'Date']) {
      params.append('metadataHeaders', h);
    }
    const res = await this.authed(
      `${GMAIL_API}/messages/${encodeURIComponent(id)}?${params.toString()}`,
      getToken,
      setToken,
      config,
    );
    if (!res) return null;
    return (await res.json()) as GmailMessage;
  }

  /** authedFetch wrapper that refreshes the token once on 401 and surfaces
   *  rate-limit stop conditions. Returns null on a non-recoverable non-2xx. */
  private async authed(
    url: string,
    getToken: () => string,
    setToken: (t: string) => void,
    config: ConnectorConfig,
  ): Promise<Response | null> {
    let { res, rate } = await authedFetch(url, getToken());
    if (res.status === 401) {
      const refreshed = await this.oauth.refresh(config).catch(() => null);
      if (!refreshed) throw new Error('gmail: token refresh failed');
      setToken(refreshed.accessToken);
      ({ res, rate } = await authedFetch(url, refreshed.accessToken));
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      this.log.warn(`gmail fetch ${res.status}: ${text.slice(0, 160)}`);
      return null;
    }
    if (rate.remaining !== undefined && rate.remaining < 5) {
      // Flag the low quota; the hydration loop backs off after this message.
      this.lowOnQuota = true;
    }
    return res;
  }

  /** Keep `lastHistoryId` at the numerically newest watermark seen. */
  private advanceCursor(candidate: string | undefined): void {
    if (!candidate) return;
    const next = Number(candidate);
    if (!Number.isFinite(next)) return;
    const current = this.lastHistoryId ? Number(this.lastHistoryId) : -1;
    if (next > current) this.lastHistoryId = candidate;
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

interface ParsedAddress {
  name?: string;
  email: string;
}

function indexHeaders(
  headers: Array<{ name: string; value: string }>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers) {
    if (h?.name) out[h.name.toLowerCase()] = h.value ?? '';
  }
  return out;
}

/** Parse a single RFC 5322 address like `Ada Lovelace <ada@x.io>`. */
function parseAddress(raw: string | undefined): ParsedAddress | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const angle = trimmed.match(/^(.*)<([^>]+)>\s*$/);
  if (angle) {
    const name = angle[1]?.trim().replace(/^"|"$/g, '').trim();
    const email = angle[2]?.trim().toLowerCase() ?? '';
    if (!email) return null;
    return name ? { name, email } : { email };
  }
  const email = trimmed.toLowerCase();
  if (!email || !email.includes('@')) return null;
  return { email };
}

/** Split a comma-separated address list, respecting angle-bracketed addresses. */
function parseAddressList(raw: string | undefined): ParsedAddress[] {
  if (!raw) return [];
  const out: ParsedAddress[] = [];
  let depth = 0;
  let inQuotes = false;
  let buf = '';
  for (const ch of raw) {
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (!inQuotes) {
      if (ch === '<') depth++;
      else if (ch === '>') depth = Math.max(0, depth - 1);
    }
    // Only split on commas that are outside quotes and angle brackets, so
    // display names like "Doe, John" <j@x.io> stay intact.
    if (ch === ',' && depth === 0 && !inQuotes) {
      const parsed = parseAddress(buf);
      if (parsed) out.push(parsed);
      buf = '';
    } else {
      buf += ch;
    }
  }
  const last = parseAddress(buf);
  if (last) out.push(last);
  return out;
}

function internalDateToIso(internalDate: string | undefined): string | null {
  if (!internalDate) return null;
  const ms = Number(internalDate);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
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
