// Bookmarks connector — imports a browser bookmarks export and ingests every
// bookmark as a `bookmark` KGNode.  Two interchange formats are supported:
//
//   1. Netscape Bookmark File Format — the `<A HREF=...>` / `<H3>folder</H3>`
//      HTML that Chrome, Firefox, Edge, and Safari all emit on "Export
//      bookmarks".  Folder nesting is expressed with `<DL>` / `<DT>` lists.
//   2. OPML — the `<outline>` tree used by feed readers and some bookmark
//      managers.  An outline carrying an `xmlUrl`/`htmlUrl`/`url` attribute is
//      treated as a bookmark; a bare outline (children only) is a folder.
//
// There is no upstream API: the export is supplied as a string via
// ConnectorConfig.credentials (stored in the `accessToken` field, following the
// Zotero/Pieces convention of stashing non-OAuth config there).  An optional
// `format` hint (`'html' | 'opml' | 'auto'`) lives in `extra.format`; when
// absent the parser sniffs the content.
//
// Mapping:
//   • bookmark        → KGNode { type: 'bookmark', label=title, sourceUrl=href }
//   • folder          → KGNode { type: 'bookmark' } + child --PART_OF--> folder
//   • tag (per-mark)  → KGNode { type: 'concept' } + mark --TAGGED_WITH--> tag
//
// Idempotency (Rule 12): every node id is derived from a stable key via
// deterministicUuid, so re-importing the same export MERGEs rather than
// duplicates.  Folder and tag nodes are keyed by their (lower-cased) path/text
// so the same folder or tag collapses to a single node across bookmarks.
//
// Rate limits (Rule 13): not applicable — parsing is purely local.

import { Injectable, Logger } from '@nestjs/common';
import type { ConnectorConfig, KGEdge, KGNode } from '@pkg/shared';
import { BaseConnector, type RawItem, type TransformResult } from './base.connector';
import { deterministicUuid, isoNow, newEdgeId } from './connector-utils';
import { OAuthService } from '../oauth/oauth.service';

const CONNECTOR_ID = 'bookmarks' as const;
const MAX_LABEL_LENGTH = 200;
const FOLDER_EDGE_WEIGHT = 0.5;
const TAG_EDGE_WEIGHT = 0.45;

type BookmarkFormat = 'html' | 'opml' | 'auto';

/** Parsed representation of a single bookmark, independent of source format. */
interface ParsedBookmark {
  href: string;
  title: string;
  /** Folder path from root → leaf, e.g. ['Toolbar', 'Dev']. */
  folders: string[];
  /** Free-form tags attached to the bookmark. */
  tags: string[];
  /** Seconds-since-epoch add date (Netscape ADD_DATE), if present. */
  addDate?: number;
  /** ISO-8601 creation time when derivable. */
  createdAt?: string;
}

interface BookmarkCredentialBlob {
  /** The raw export document (HTML or OPML). */
  accessToken: string;
  extra?: { format?: BookmarkFormat };
}

@Injectable()
export class BookmarksConnector extends BaseConnector {
  private readonly log = new Logger(BookmarksConnector.name);
  readonly id = CONNECTOR_ID;
  readonly oauthScopes = [] as const;
  override readonly authType = 'apikey' as const;

  constructor(private readonly oauth: OAuthService) {
    super();
  }

  // ── fetchIncremental ──────────────────────────────────────────────────────

  // The whole export is parsed up front (it is a single in-memory string) and
  // each bookmark is yielded as a RawItem.  `since` filters by add-date when
  // one is available, so re-runs against a growing export only surface new
  // bookmarks; bookmarks without a date are always yielded (they MERGE
  // idempotently downstream).
  async *fetchIncremental(
    config: ConnectorConfig,
    since: Date,
  ): AsyncGenerator<RawItem> {
    const creds = this.oauth.decryptCredentials(config) as BookmarkCredentialBlob;
    const document = creds.accessToken ?? '';
    if (!document.trim()) {
      this.log.warn('bookmarks: empty export document; nothing to ingest');
      return;
    }

    const format = resolveFormat(document, creds.extra?.format);
    let bookmarks: ParsedBookmark[];
    try {
      bookmarks = format === 'opml' ? parseOpml(document) : parseNetscape(document);
    } catch (err) {
      this.log.warn(`bookmarks: failed to parse ${format} export: ${String(err)}`);
      return;
    }

    const sinceMs = since.getTime();
    for (const bookmark of bookmarks) {
      if (
        bookmark.addDate !== undefined &&
        bookmark.addDate * 1000 <= sinceMs
      ) {
        continue;
      }
      yield {
        externalId: externalIdFor(bookmark),
        raw: { bookmark, observedAt: isoNow() },
      };
    }
  }

  // ── transform ─────────────────────────────────────────────────────────────

  transform(raw: RawItem): TransformResult {
    const { bookmark } = raw.raw as { bookmark: ParsedBookmark };

    const createdAt =
      bookmark.createdAt ??
      (bookmark.addDate !== undefined
        ? new Date(bookmark.addDate * 1000).toISOString()
        : isoNow());

    const node: KGNode = {
      id: deterministicUuid(CONNECTOR_ID, externalIdFor(bookmark)),
      type: 'bookmark',
      label: (bookmark.title || bookmark.href).slice(0, MAX_LABEL_LENGTH),
      sourceId: CONNECTOR_ID,
      ...(bookmark.href ? { sourceUrl: bookmark.href } : {}),
      createdAt,
      updatedAt: isoNow(),
      metadata: {
        href: bookmark.href,
        addDate: bookmark.addDate ?? null,
        folder: bookmark.folders.length ? bookmark.folders.join(' / ') : null,
        folderPath: bookmark.folders,
        tags: bookmark.tags,
      },
    };

    const edges: KGEdge[] = [];

    // Folder → PART_OF.  Only the immediate (deepest) folder owns the bookmark;
    // the folder node itself is keyed by its full path so nested folders with
    // the same leaf name stay distinct.
    if (bookmark.folders.length > 0) {
      const folderPath = bookmark.folders;
      const folderKey = `folder:${folderPath.join('/').toLowerCase()}`;
      const folderId = deterministicUuid(CONNECTOR_ID, folderKey);
      const edge = edgeBetween(node.id, folderId, 'PART_OF', FOLDER_EDGE_WEIGHT);
      edge.metadata = {
        folderLabel: folderPath[folderPath.length - 1] ?? '',
        folderPath,
        folderId,
      };
      edges.push(edge);
    }

    // Tags → concept + TAGGED_WITH.  A tag node is keyed by its lower-cased
    // text so the same tag shared by many bookmarks collapses into one concept.
    for (const tag of bookmark.tags) {
      const text = tag.trim();
      if (!text) continue;
      const tagId = deterministicUuid(
        CONNECTOR_ID,
        `tag:${text.toLowerCase()}`,
      );
      const edge = edgeBetween(node.id, tagId, 'TAGGED_WITH', TAG_EDGE_WEIGHT);
      edge.metadata = { tagLabel: text, tagId, conceptType: 'concept' };
      edges.push(edge);
    }

    return { node, edges };
  }
}

// ── format detection ────────────────────────────────────────────────────────

function resolveFormat(document: string, hint?: BookmarkFormat): 'html' | 'opml' {
  if (hint === 'html' || hint === 'opml') return hint;
  // Sniff: OPML documents declare an <opml> root; Netscape exports declare the
  // NETSCAPE-Bookmark doctype or use <DL>/<A HREF> lists.
  const head = document.slice(0, 2048).toLowerCase();
  if (head.includes('<opml')) return 'opml';
  if (head.includes('netscape-bookmark') || head.includes('<dl')) return 'html';
  // Fall back to OPML only when it clearly looks like XML with <outline>; else
  // default to the far more common Netscape HTML format.
  if (head.includes('<outline')) return 'opml';
  return 'html';
}

/** Stable dedupe key for a bookmark.  Prefer the href (a bookmark IS its URL);
 *  fall back to folder-path + title for the rare href-less entry. */
function externalIdFor(bookmark: ParsedBookmark): string {
  if (bookmark.href.trim()) return `mark:${bookmark.href.trim()}`;
  return `mark:${bookmark.folders.join('/')}#${bookmark.title}`;
}

// ── Netscape Bookmark File parser ───────────────────────────────────────────
//
// The format is loosely-structured HTML, so we scan it with a small tokenizer
// rather than a full DOM.  We walk tags in order, maintaining a folder stack:
//   <H3 ...>Name</H3>   → push the folder named "Name" once the next <DL> opens
//   <DL>                → enter the pending folder
//   </DL>               → leave the current folder
//   <A HREF=...>Title</A> → a bookmark in the current folder
//
// Browsers nest one <DL> per folder, and the <H3> precedes the child <DL>, so
// we stage the most recent heading and commit it to the stack on the next <DL>.

function parseNetscape(html: string): ParsedBookmark[] {
  const bookmarks: ParsedBookmark[] = [];
  const folderStack: string[] = [];
  let pendingFolder: string | null = null;

  // Match opening <DL>, closing </DL>, <H3 ...>text</H3>, and <A ...>text</A>.
  const tokenRe =
    /<\/dl>|<dl[^>]*>|<h3[^>]*>([\s\S]*?)<\/h3>|<a\b([^>]*)>([\s\S]*?)<\/a>/gi;

  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(html)) !== null) {
    const token = match[0].toLowerCase();

    if (token.startsWith('<dl')) {
      // Entering a folder list — commit any pending heading.
      folderStack.push(pendingFolder ?? '');
      pendingFolder = null;
      continue;
    }
    if (token === '</dl>') {
      folderStack.pop();
      continue;
    }
    if (token.startsWith('<h3')) {
      pendingFolder = decodeEntities(stripTags(match[1] ?? '')).trim();
      continue;
    }
    // <a ...> anchor → a bookmark.
    const attrs = match[2] ?? '';
    const inner = decodeEntities(stripTags(match[3] ?? '')).trim();
    const href = decodeEntities(getAttr(attrs, 'href') ?? '').trim();
    if (!href) continue;

    const addDateRaw = getAttr(attrs, 'add_date');
    const addDate = addDateRaw ? Number(addDateRaw) : undefined;
    const tagsRaw = getAttr(attrs, 'tags');
    const tags = tagsRaw
      ? tagsRaw
          .split(',')
          .map((t) => decodeEntities(t).trim())
          .filter(Boolean)
      : [];

    bookmarks.push({
      href,
      title: inner || href,
      // The first stack entry is the implicit root list (empty name); drop
      // blanks so the path contains only real folder names.
      folders: folderStack.filter((f) => f.length > 0),
      tags,
      ...(addDate !== undefined && Number.isFinite(addDate) ? { addDate } : {}),
    });
  }

  return bookmarks;
}

// ── OPML parser ─────────────────────────────────────────────────────────────
//
// OPML nests <outline> elements.  An outline with a link attribute is a
// bookmark; an outline with only children is a folder.  We walk the raw XML
// with a tag scanner, tracking the folder stack via self-closing vs. paired
// outline tags.

function parseOpml(xml: string): ParsedBookmark[] {
  const bookmarks: ParsedBookmark[] = [];
  const folderStack: string[] = [];

  // Match <outline .../> (self-closing), <outline ...> (open), and </outline>.
  const tagRe = /<outline\b([^>]*?)(\/?)>|<\/outline>/gi;

  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(xml)) !== null) {
    if (match[0].toLowerCase() === '</outline>') {
      folderStack.pop();
      continue;
    }

    const attrs = match[1] ?? '';
    const selfClosing = match[2] === '/';
    const text =
      decodeEntities(getAttr(attrs, 'text') ?? getAttr(attrs, 'title') ?? '').trim();
    const href = decodeEntities(
      getAttr(attrs, 'url') ??
        getAttr(attrs, 'htmlurl') ??
        getAttr(attrs, 'xmlurl') ??
        '',
    ).trim();

    if (href) {
      // Leaf bookmark.  A self-closing leaf does not change the folder stack;
      // a paired (open) leaf with no link children still gets popped on its
      // closing tag, which is harmless.
      const tagsRaw = getAttr(attrs, 'category') ?? getAttr(attrs, 'tags');
      const tags = tagsRaw
        ? tagsRaw
            .split(/[,/]/)
            .map((t) => decodeEntities(t).trim())
            .filter(Boolean)
        : [];
      const created = getAttr(attrs, 'created');
      bookmarks.push({
        href,
        title: text || href,
        // Drop blank entries (e.g. a paired-leaf placeholder, see below) so the
        // path contains only real folder names.
        folders: folderStack.filter((f) => f.length > 0),
        tags,
        ...(created ? { createdAt: created } : {}),
      });
      if (!selfClosing) {
        // Paired (non-self-closing) leaf — its </outline> will pop, so push an
        // empty placeholder to keep the stack balanced.  Crucially we do NOT
        // push the leaf's title: a bookmark is not a folder, so any (unusual)
        // outlines nested inside it must not inherit this title as a folder.
        folderStack.push('');
      }
      continue;
    }

    // Folder outline.
    if (!selfClosing) {
      folderStack.push(text);
    }
  }

  return bookmarks;
}

// ── tiny HTML/XML helpers ───────────────────────────────────────────────────

/** Read an attribute value from a raw tag attribute string. Handles single,
 *  double, and unquoted values; attribute name match is case-insensitive. */
function getAttr(attrs: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = re.exec(attrs);
  if (!m) return undefined;
  return m[2] ?? m[3] ?? m[4];
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, '');
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  '#34': '"',
  nbsp: ' ',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z0-9]+);/gi, (whole, body: string) => {
    const key = body.toLowerCase();
    if (key in ENTITIES) return ENTITIES[key] as string;
    if (body.startsWith('#x') || body.startsWith('#X')) {
      return codePointToString(parseInt(body.slice(2), 16), whole);
    }
    if (body.startsWith('#')) {
      return codePointToString(parseInt(body.slice(1), 10), whole);
    }
    return whole;
  });
}

/** Convert a numeric character reference to a string, leaving the original
 *  entity intact when the code point is invalid.  String.fromCodePoint throws a
 *  RangeError on out-of-range or (some engines) surrogate-range values, so the
 *  bounds are checked first — a malformed `&#xD800;` in one title must not abort
 *  the entire import. */
function codePointToString(code: number, fallback: string): string {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return fallback;
  // Lone surrogates (0xD800–0xDFFF) are not valid scalar values.
  if (code >= 0xd800 && code <= 0xdfff) return fallback;
  return String.fromCodePoint(code);
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
