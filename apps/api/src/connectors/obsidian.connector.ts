// Obsidian vault connector — ingests an Obsidian vault supplied as a list of
// already-extracted markdown files. This connector deliberately does NOT do any
// ZIP decompression or filesystem I/O: callers (the upload/sync layer) extract
// the vault and pass the `{path, content}` entries in via the connector config
// credentials blob. That keeps `transform` a pure function and the whole
// connector trivially unit-testable with in-memory fixtures.
//
// Mapping (mirrors the markdown→graph conventions in public/text-parser.ts, but
// re-implements the minimal regexes locally rather than importing private
// internals):
//   - each note file        → one `note` KGNode (label = note title)
//   - `[[wikilinks]]`        → `LINKS_TO` edges, resolved by note **title** so a
//                              link to "Daily/2024-01-01" or "2024-01-01"
//                              collapses onto whichever note carries that title
//   - `#tags`                → `concept` KGNodes + `TAGGED_WITH` edges
//
// Idempotency (Rule 12): node ids are derived deterministically from stable
// keys (`note:<title>`, `tag:<tag>`) via `deterministicUuid`, so re-syncing the
// same vault MERGEs rather than inserts, and two notes that link to the same
// title resolve to the same target id without a second pass.

import { Injectable, Logger } from '@nestjs/common';
import type { ConnectorConfig, KGEdge, KGNode } from '@pkg/shared';
import { BaseConnector, type RawItem, type TransformResult } from './base.connector';
import { deterministicUuid, isoNow, newEdgeId } from './connector-utils';
import { OAuthService } from '../oauth/oauth.service';

// ── Connector input shapes ────────────────────────────────────────────────

/** One extracted markdown file from the vault. */
export interface ObsidianFile {
  /** Vault-relative path, e.g. "Projects/Graph.md". */
  path: string;
  /** Raw markdown content of the note. */
  content: string;
  /** Optional upstream mtime (ISO-8601). Used for incremental `since` filtering. */
  modifiedAt?: string;
}

/** Shape stored in the (decrypted) credentials blob for this connector. The
 *  upload/sync layer extracts the vault and stashes the file list here; we never
 *  touch a real ZIP or the filesystem. */
interface ObsidianVaultPayload {
  files?: ObsidianFile[];
}

const MAX_LABEL_LENGTH = 200;
const TAG_EDGE_WEIGHT = 0.5;
const WIKILINK_EDGE_WEIGHT = 0.55;

// ── Connector ─────────────────────────────────────────────────────────────

@Injectable()
export class ObsidianConnector extends BaseConnector {
  private readonly log = new Logger(ObsidianConnector.name);
  readonly id = 'obsidian' as const;
  readonly oauthScopes = [] as const;
  override readonly authType = 'apikey' as const;

  constructor(private readonly oauth: OAuthService) {
    super();
  }

  // ── fetchIncremental ──────────────────────────────────────────────────
  //
  // No network: the vault file list rides in the credentials blob. We yield one
  // RawItem per note, skipping files whose `modifiedAt` predates `since` (when
  // present) so re-syncs stay incremental and cheap.
  async *fetchIncremental(
    config: ConnectorConfig,
    since: Date,
  ): AsyncGenerator<RawItem> {
    const files = this.extractFiles(config);
    const sinceMs = since.getTime();

    for (const file of files) {
      if (!file?.path || typeof file.content !== 'string') continue;
      if (!isMarkdownPath(file.path)) continue;

      if (file.modifiedAt) {
        const modMs = Date.parse(file.modifiedAt);
        if (Number.isFinite(modMs) && modMs <= sinceMs) continue;
      }

      yield {
        externalId: `note:${file.path}`,
        raw: { file, observedAt: isoNow() },
      };
    }
  }

  // ── transform ─────────────────────────────────────────────────────────
  //
  // Pure: a single file → one note node plus its tag/wikilink edges. Wikilink
  // targets resolve to deterministic ids keyed on the linked **title**, so the
  // edge lands on the matching note node even though that note is transformed
  // by a separate call.
  transform(raw: RawItem): TransformResult {
    const { file } = raw.raw as { file: ObsidianFile; observedAt: string };

    const title = noteTitle(file.path);
    const node: KGNode = {
      id: noteId(title),
      type: 'note',
      label: title.slice(0, MAX_LABEL_LENGTH),
      sourceId: 'obsidian',
      createdAt: file.modifiedAt ?? isoNow(),
      updatedAt: file.modifiedAt ?? isoNow(),
      metadata: {
        path: file.path,
        title,
        length: file.content.length,
      },
    };

    const edges: KGEdge[] = [];

    // #tags → concept nodes + TAGGED_WITH. Tag identity lives in edge metadata
    // (the Pieces/Zotero convention) so the backing concept node can be minted
    // by a downstream upsert; the deterministic id keeps it idempotent.
    for (const tag of extractTags(file.content)) {
      const tagId = deterministicUuid('obsidian', `tag:${tag}`);
      const edge = edgeBetween(node.id, tagId, 'TAGGED_WITH', TAG_EDGE_WEIGHT);
      edge.metadata = { tagLabel: `#${tag}`, tag, tagId, nodeType: 'concept' };
      edges.push(edge);
    }

    // [[wikilinks]] → LINKS_TO, resolved by title. We skip self-links to avoid
    // emitting a degenerate edge.
    for (const link of extractWikilinks(file.content)) {
      const targetId = noteId(link.target);
      if (targetId === node.id) continue;
      const edge = edgeBetween(node.id, targetId, 'LINKS_TO', WIKILINK_EDGE_WEIGHT);
      edge.metadata = {
        targetTitle: link.target,
        ...(link.section ? { section: link.section } : {}),
        ...(link.alias ? { alias: link.alias } : {}),
        targetId,
        nodeType: 'note',
      };
      edges.push(edge);
    }

    return { node, edges };
  }

  // ── helpers ───────────────────────────────────────────────────────────

  /** Pull the extracted vault file list out of the decrypted credentials blob.
   *  The blob is JSON-encoded in the credential `accessToken` field (consistent
   *  with how the Pieces connector overloads that field for non-OAuth config). */
  private extractFiles(config: ConnectorConfig): ObsidianFile[] {
    const creds = this.oauth.decryptCredentials(config);
    const token = creds.accessToken?.trim();
    if (!token) return [];
    let payload: ObsidianVaultPayload;
    try {
      payload = JSON.parse(token) as ObsidianVaultPayload;
    } catch (err) {
      this.log.warn(`obsidian vault payload is not valid JSON: ${String(err)}`);
      return [];
    }
    return Array.isArray(payload.files) ? payload.files : [];
  }
}

// ── pure parsing helpers (minimal re-implementation of text-parser regexes) ──

function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown)$/i.test(path.trim());
}

/** Derive a note title from its vault path: strip directories and the .md
 *  extension. Wikilinks in Obsidian resolve against this short title (the file
 *  basename), so target resolution keys on the same value. */
function noteTitle(path: string): string {
  const base = path.replace(/\\/g, '/').split('/').pop() ?? path;
  return base.replace(/\.(md|markdown)$/i, '').trim() || path.trim();
}

/** Deterministic note-node id keyed on the (case-folded) title so links and the
 *  note they point at resolve to the same id regardless of path or call order. */
function noteId(title: string): string {
  return deterministicUuid('obsidian', `note:${title.trim().toLowerCase()}`);
}

/** `#tags` → lowercased, de-duplicated tag slugs. Mirrors text-parser's tag
 *  regex (leading boundary, letter-led, word/`-` body). */
function extractTags(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of text.matchAll(/(?:^|\s)#([A-Za-z][\w-]{1,40})/g)) {
    const tag = match[1]?.toLowerCase();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

interface Wikilink {
  target: string;
  section?: string;
  alias?: string;
}

/** `[[Target]]`, `[[Target|Alias]]`, `[[Target#Section|Alias]]` →
 *  de-duplicated (by target) wikilink descriptors. */
function extractWikilinks(text: string): Wikilink[] {
  const seen = new Set<string>();
  const out: Wikilink[] = [];
  for (const match of text.matchAll(
    /\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g,
  )) {
    const target = match[1]?.trim();
    if (!target) continue;
    const key = target.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const section = match[2]?.trim();
    const alias = match[3]?.trim();
    out.push({
      target,
      ...(section ? { section } : {}),
      ...(alias ? { alias } : {}),
    });
  }
  return out;
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
