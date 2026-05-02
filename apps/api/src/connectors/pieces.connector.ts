// Pieces for Developers connector — fetches assets (code snippets, notes, and
// other saved items) from a locally-running Pieces OS instance and ingests them
// into the knowledge graph.  Each asset becomes a KGNode; tags become nodes
// connected via TAGGED_WITH; websites become nodes connected via LINKS_TO.
//
// Authentication / configuration:
//   The Pieces OS REST API runs locally (default: http://localhost:1000) and
//   does not require an API key for same-machine access.  The credential
//   `accessToken` field is treated as the **base URL** so users can override
//   the host/port if they changed it in Pieces OS settings.  An empty or
//   missing value falls back to `http://localhost:1000`.
//
// Incremental sync (Rule 12): Pieces OS does not accept a `since` filter on
//   GET /assets, so we walk assets ordered by `updated` descending and stop as
//   soon as we cross the `since` boundary.  Node ids are derived from the
//   stable asset UUID via `deterministicUuid` — re-syncing the same asset is a
//   MERGE rather than an INSERT.
//
// Cortex categorization:
//   Assets with a detected programming language land in the `motor` region via
//   the `commit` node type.  Plain-text notes and generic snippets land in the
//   `memory` region via the `note` node type.  The cortex's `regionForNode`
//   function maps these types automatically — no extra wiring is required here.
//
// Docs: https://docs.pieces.app/docs/pieces-os-api/introduction

import { Injectable, Logger } from '@nestjs/common';
import type { ConnectorConfig, KGEdge, KGNode } from '@pkg/shared';
import { BaseConnector, type RawItem, type TransformResult } from './base.connector';
import { deterministicUuid, isoNow, newEdgeId } from './connector-utils';
import { OAuthService } from '../oauth/oauth.service';

// ── Pieces OS API shapes ──────────────────────────────────────────────────

interface PiecesTimestamp {
  /** ISO-8601 datetime string */
  value?: string;
}

interface PiecesClassification {
  /** Generic content kind, e.g. "CODE", "TEXT" */
  generic?: string;
  /** Language key, e.g. "typescript", "python", "shell" */
  specific?: string;
}

interface PiecesStringFragment {
  raw?: string;
}

interface PiecesFragment {
  string?: PiecesStringFragment;
}

interface PiecesFormat {
  classification?: PiecesClassification;
  fragment?: PiecesFragment;
}

interface PiecesFormats {
  iterable?: PiecesFormat[];
}

interface PiecesTag {
  id: string;
  text: string;
}

interface PiecesTags {
  iterable?: PiecesTag[];
}

interface PiecesWebsite {
  id: string;
  url: string;
  name?: string;
}

interface PiecesWebsites {
  iterable?: PiecesWebsite[];
}

interface PiecesDescriptionOnboarding {
  text?: string;
}

interface PiecesDescription {
  onboarding?: PiecesDescriptionOnboarding;
}

interface PiecesAsset {
  id: string;
  name?: string;
  description?: PiecesDescription;
  created: PiecesTimestamp;
  updated: PiecesTimestamp;
  tags?: PiecesTags;
  websites?: PiecesWebsites;
  formats?: PiecesFormats;
}

interface PiecesAssetsResponse {
  iterable: PiecesAsset[];
}

// ── Connector constants ───────────────────────────────────────────────────

const DEFAULT_BASE_URL = 'http://localhost:1000';
const PAGE_SIZE = 50;
const MAX_PAGES = 4; // 200 assets per sync — keeps each run reasonably bounded
const FETCH_TIMEOUT_MS = 8_000;
const MAX_LABEL_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 500;

// Weight constants for edges
const TAG_EDGE_WEIGHT = 0.5;
const WEBSITE_EDGE_WEIGHT = 0.6;

@Injectable()
export class PiecesConnector extends BaseConnector {
  private readonly log = new Logger(PiecesConnector.name);
  readonly id = 'pieces' as const;
  readonly oauthScopes = [] as const;
  override readonly authType = 'apikey' as const;

  constructor(private readonly oauth: OAuthService) {
    super();
  }

  // ── fetchIncremental ────────────────────────────────────────────────────

  async *fetchIncremental(
    config: ConnectorConfig,
    since: Date,
  ): AsyncGenerator<RawItem> {
    const creds = this.oauth.decryptCredentials(config);
    // `accessToken` stores the Pieces OS base URL (or empty for default).
    const baseUrl = resolveBaseUrl(creds.accessToken);

    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({
        max: String(PAGE_SIZE),
        ...(page > 0 ? { offset: String(page * PAGE_SIZE) } : {}),
      });

      let res: Response;
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
        try {
          res = await fetch(`${baseUrl}/assets?${params.toString()}`, {
            signal: ctl.signal,
            headers: { accept: 'application/json' },
          });
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        this.log.warn(`pieces fetch error (page ${page}): ${String(err)}`);
        return;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        this.log.warn(`pieces /assets ${res.status}: ${text.slice(0, 160)}`);
        return;
      }

      const json = (await res.json()) as PiecesAssetsResponse;
      const assets = json?.iterable;
      if (!Array.isArray(assets) || assets.length === 0) return;

      let crossedSince = false;
      for (const asset of assets) {
        const updatedMs = Date.parse(asset.updated?.value ?? '');
        if (Number.isFinite(updatedMs) && updatedMs <= since.getTime()) {
          crossedSince = true;
          break;
        }
        yield {
          externalId: asset.id,
          raw: { asset, observedAt: isoNow() },
        };
      }

      if (crossedSince || assets.length < PAGE_SIZE) return;
      if (page === MAX_PAGES - 1) {
        this.log.warn(
          `pieces hit fetch ceiling (${MAX_PAGES * PAGE_SIZE} assets); remaining items deferred to next sync`,
        );
      }
    }
  }

  // ── transform ───────────────────────────────────────────────────────────

  transform(raw: RawItem): TransformResult {
    const { asset } = raw.raw as { asset: PiecesAsset; observedAt: string };

    const language = detectLanguage(asset);
    // Code snippets with a detected language land in the `motor` region (commit
    // type); plain notes / generic text land in `memory` (note type).  The
    // cortex's regionForNode mapping drives the final categorization.
    const nodeType: KGNode['type'] = language ? 'commit' : 'note';

    const label = resolveLabel(asset, language);
    const description = asset.description?.onboarding?.text ?? null;

    const node: KGNode = {
      id: deterministicUuid('pieces', asset.id),
      type: nodeType,
      label,
      sourceId: 'pieces',
      createdAt: asset.created?.value ?? isoNow(),
      updatedAt: asset.updated?.value ?? isoNow(),
      metadata: {
        piecesId: asset.id,
        language: language ?? null,
        description: description?.slice(0, MAX_DESCRIPTION_LENGTH) ?? null,
        tagCount: asset.tags?.iterable?.length ?? 0,
        websiteCount: asset.websites?.iterable?.length ?? 0,
      },
    };

    const edges: KGEdge[] = [];

    // Tag → TAGGED_WITH edges.  Tag nodes are referenced by label so the same
    // tag applied across many snippets collapses into one node (idempotent via
    // deterministicUuid).  Following the established Zotero connector pattern,
    // the tag node identity is embedded in edge.metadata; a future NLP pass or
    // the graph service's upsert logic can create the backing nodes if needed.
    for (const tag of asset.tags?.iterable ?? []) {
      if (!tag?.text?.trim()) continue;
      const tagId = deterministicUuid('pieces', `tag:${tag.text.trim().toLowerCase()}`);
      const edge = edgeBetween(node.id, tagId, 'TAGGED_WITH', TAG_EDGE_WEIGHT);
      edge.metadata = { tagLabel: tag.text.trim(), tagId };
      edges.push(edge);
    }

    // Website → LINKS_TO edges.  Websites captured alongside a snippet in
    // Pieces represent the origin or reference for the snippet.  The website
    // node identity is stored in edge.metadata following the Zotero pattern.
    for (const website of asset.websites?.iterable ?? []) {
      if (!website?.url?.trim()) continue;
      const websiteId = deterministicUuid('pieces', `website:${website.url.trim()}`);
      const edge = edgeBetween(node.id, websiteId, 'LINKS_TO', WEBSITE_EDGE_WEIGHT);
      edge.metadata = {
        websiteUrl: website.url.trim(),
        websiteName: website.name ?? null,
        websiteId,
      };
      edges.push(edge);
    }

    return { node, edges };
  }
}

// ── helpers ───────────────────────────────────────────────────────────────

/**
 * Resolve the Pieces OS base URL from the stored credential.  The
 * `accessToken` carries the base URL (an unusual usage for this field, but
 * consistent with the Zotero pattern of embedding extra config in credentials).
 * Falls back to the standard local default when empty.
 */
function resolveBaseUrl(token: string): string {
  const t = token?.trim();
  if (!t) return DEFAULT_BASE_URL;
  // Accept either a plain host:port or a full http(s):// URL.
  if (/^https?:\/\//i.test(t)) return t.replace(/\/+$/, '');
  return `http://${t}`;
}

/**
 * Walk the formats array and return the most-specific language key found, or
 * null when no programming language is detected.  Pieces stores the language
 * inside `format.classification.specific` for code formats.
 */
function detectLanguage(asset: PiecesAsset): string | null {
  const formats = asset.formats?.iterable ?? [];
  for (const fmt of formats) {
    const specific = fmt.classification?.specific?.trim().toLowerCase();
    if (specific && specific !== 'text' && specific !== 'unknown') {
      return specific;
    }
  }
  return null;
}

/**
 * Derive a human-readable label for the node.  Priority:
 *   1. `asset.name` (if the user named the snippet in Pieces)
 *   2. First 80 chars of the raw snippet content (for code assets)
 *   3. `asset.id` as a last resort
 */
function resolveLabel(asset: PiecesAsset, language: string | null): string {
  if (asset.name?.trim()) return asset.name.trim().slice(0, MAX_LABEL_LENGTH);

  // Extract raw content from the first format that has string content.
  const formats = asset.formats?.iterable ?? [];
  for (const fmt of formats) {
    const raw = fmt.fragment?.string?.raw?.trim();
    if (raw && raw.length > 0) {
      const firstLine = raw.split('\n')[0]?.trim() ?? '';
      const snippet = firstLine.length > 0 ? firstLine : raw;
      const lang = language ? ` (${language})` : '';
      return `${snippet.slice(0, 120)}${lang}`.trim().slice(0, MAX_LABEL_LENGTH);
    }
  }

  return asset.id.slice(0, MAX_LABEL_LENGTH);
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
