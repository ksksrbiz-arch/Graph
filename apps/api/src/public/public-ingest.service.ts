// Service backing the public, anonymous ingest path. Wraps GraphService
// so paste-in-the-website can produce real KGNodes for the demo userId,
// pokes the brain via SensoryService.perceive(), and queues a debounced
// connectome reload so newly-added nodes start firing soon after.
//
// Intentionally narrow surface — only the demo userIds in
// PUBLIC_INGEST_USER_IDS may write through this path. Wider, multi-tenant
// ingest belongs behind the JWT-guarded sync orchestrator (Phases 1+).

import {
  ForbiddenException,
  Injectable,
  Logger,
  PayloadTooLargeException,
} from '@nestjs/common';
import type { KGEdge, KGNode } from '@pkg/shared';
import { loadEnv } from '../config/env';
import { splitCsvEnv } from '../config/env-utils';
import { BrainService } from '../brain/brain.service';
import { SensoryService } from '../brain/sensory.service';
import { GraphService } from '../graph/graph.service';
import {
  parseMarkdown,
  parseText,
  type ParseResult,
} from './text-parser';

export interface PublicIngestRequest {
  userId: string;
  format: 'text' | 'markdown' | 'url';
  content: string;
  title?: string;
}

export interface PublicIngestResult {
  userId: string;
  format: 'text' | 'markdown';
  parentId: string;
  nodes: number;
  edges: number;
  brainQueuedReload: boolean;
}

const RELOAD_DEBOUNCE_MS = 4_000;

@Injectable()
export class PublicIngestService {
  private readonly log = new Logger(PublicIngestService.name);
  private readonly env = loadEnv();
  private readonly allowedUserIds = new Set(splitCsvEnv(this.env.PUBLIC_INGEST_USER_IDS));
  private readonly maxBytes = this.env.PUBLIC_INGEST_MAX_BYTES;
  private readonly reloadTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly graph: GraphService,
    private readonly sensory: SensoryService,
    private readonly brain: BrainService,
  ) {}

  /** True when the public ingest path is configured for at least one user. */
  isEnabled(): boolean {
    return this.allowedUserIds.size > 0;
  }

  /** Allowlist + body-size gate. Throws on rejection so the controller
   *  surfaces 403 / 413 with the right message. */
  assertAllowed(userId: string, contentLength: number): void {
    if (!this.allowedUserIds.has(userId)) {
      throw new ForbiddenException(
        `userId=${userId} is not on the public ingest allowlist`,
      );
    }
    if (contentLength > this.maxBytes) {
      throw new PayloadTooLargeException(
        `payload exceeds ${this.maxBytes} bytes (got ${contentLength})`,
      );
    }
  }

  /** Parse + upsert + perceive. Returns counts so the controller can echo a
   *  receipt the SPA renders inline. */
  async ingest(req: PublicIngestRequest): Promise<PublicIngestResult> {
    this.assertAllowed(req.userId, Buffer.byteLength(req.content, 'utf8'));

    const title = (req.title || defaultTitle(req)).slice(0, 200);
    const parsed = req.format === 'markdown'
      ? parseMarkdown(req.content, { userId: req.userId, sourceId: 'obsidian', title })
      : parseText(req.content, { userId: req.userId, sourceId: 'bookmarks', title });

    await this.persist(req.userId, parsed);

    let queued = false;
    if (this.brain.isRunning(req.userId)) {
      // Existing connectome only gets stimuli for neurons it already knows
      // about — perceive() is a no-op otherwise. The debounced reload picks
      // up the freshly-upserted neurons after a short quiet period.
      for (const node of parsed.nodes) {
        this.sensory.perceive(req.userId, node);
      }
      this.scheduleReload(req.userId);
      queued = true;
    }

    this.log.log(
      `public ingest user=${req.userId} format=${req.format} +${parsed.nodes.length} nodes / ${parsed.edges.length} edges`,
    );
    return {
      userId: req.userId,
      format: req.format,
      parentId: parsed.parentId,
      nodes: parsed.nodes.length,
      edges: parsed.edges.length,
      brainQueuedReload: queued,
    };
  }

  /** Nodes + edges added since `sinceIso`. Drives the SPA's live ticker
   *  (poll loop in graph-live.js) — clients send back the `ts` we return so
   *  the next poll only fetches what's new since this one served. */
  async snapshotDelta(
    userId: string,
    sinceIso: string,
    limit = 50_000,
  ): Promise<{
    schemaVersion: number;
    metadata: { ts: string; userId: string; since: string };
    nodes: KGNode[];
    edges: KGEdge[];
  }> {
    if (!this.allowedUserIds.has(userId)) {
      throw new ForbiddenException(`userId=${userId} is not on the public allowlist`);
    }
    const ts = new Date().toISOString();
    const { nodes, edges } = await this.graph.snapshotDeltaForUser(userId, sinceIso, limit);
    return {
      schemaVersion: 1,
      metadata: { ts, userId, since: sinceIso },
      nodes,
      edges,
    };
  }

  /** Snapshot the demo user's full graph back out so the website can render
   *  it. Cursor-based pagination is overkill at this scale (Phase 0 target is
   *  a few thousand nodes); we cap with a hard limit instead. */
  async snapshot(userId: string, limit = 50_000): Promise<{
    schemaVersion: number;
    metadata: { updatedAt: string; userId: string; sources: string[] };
    nodes: KGNode[];
    edges: KGEdge[];
  }> {
    if (!this.allowedUserIds.has(userId)) {
      throw new ForbiddenException(`userId=${userId} is not on the public allowlist`);
    }
    const { nodes, edges } = await this.graph.snapshotForUser(userId, limit);
    const sources = [...new Set(nodes.map((n) => n.sourceId))];
    return {
      schemaVersion: 1,
      metadata: { updatedAt: new Date().toISOString(), userId, sources },
      nodes,
      edges,
    };
  }

  private async persist(userId: string, parsed: ParseResult): Promise<void> {
    for (const node of parsed.nodes) {
      try {
        await this.graph.upsertNode(userId, node);
      } catch (e) {
        this.log.warn(`upsertNode failed (${node.id}): ${(e as Error).message}`);
      }
    }
    for (const edge of parsed.edges) {
      try {
        await this.graph.upsertEdge(userId, edge);
      } catch (e) {
        this.log.warn(`upsertEdge failed (${edge.id}): ${(e as Error).message}`);
      }
    }
  }

  /** Debounced brain reload — coalesces rapid pastes so we don't churn the
   *  simulator. BrainService.start() is idempotent (drops existing timers and
   *  reloads the connectome), so calling it again is safe. */
  private scheduleReload(userId: string): void {
    const existing = this.reloadTimers.get(userId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.reloadTimers.delete(userId);
      this.brain.start(userId).catch((e) => {
        this.log.warn(`brain reload failed user=${userId}: ${(e as Error).message}`);
      });
    }, RELOAD_DEBOUNCE_MS);
    if (typeof timer.unref === 'function') timer.unref();
    this.reloadTimers.set(userId, timer);
  }

  /**
   * Web-based URL ingest: server fetches the page (bypasses browser CORS),
   * extracts readable main content + title, then feeds it through the normal
   * text parser + persist + brain perceive pipeline.
   */
  async ingestUrl(userId: string, url: string, title?: string): Promise<PublicIngestResult> {
    // We don't know the final text length yet — fetch first, then gate.
    const extracted = await this.fetchAndExtract(url);

    const finalTitle = (title || extracted.title || url).slice(0, 200);
    const contentLength = Buffer.byteLength(extracted.text, 'utf8');

    // Now apply allowlist + size gate on the *extracted* text
    if (!this.allowedUserIds.has(userId)) {
      throw new ForbiddenException(`userId=${userId} is not on the public ingest allowlist`);
    }
    if (contentLength > this.maxBytes) {
      throw new PayloadTooLargeException(
        `extracted content exceeds ${this.maxBytes} bytes (got ${contentLength})`,
      );
    }

    return this.ingest({
      userId,
      format: 'text',
      content: extracted.text,
      title: finalTitle,
    });
  }

  private async fetchAndExtract(rawUrl: string): Promise<{ title: string; text: string }> {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 12_000);

    try {
      const res = await fetch(rawUrl, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (compatible; GraphIngestBot/1.0; +https://github.com/ksksrbiz-arch/Graph)',
          Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        },
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }

      const html = await res.text();
      return this.extractReadableText(html, rawUrl);
    } catch (err: any) {
      if (err.name === 'AbortError') throw new Error('fetch timed out');
      throw new Error(`Failed to fetch URL: ${err.message || err}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Lightweight but effective server-side article extractor (no extra deps). */
  private extractReadableText(html: string, baseUrl: string): { title: string; text: string } {
    // Title extraction (priority order)
    let title = '';
    const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleTag) title = this.cleanText(titleTag[1]);

    const ogTitle =
      html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([\s\S]*?)["']/i) ||
      html.match(/<meta[^>]+name=["']title["'][^>]+content=["']([\s\S]*?)["']/i);
    if (ogTitle) title = this.cleanText(ogTitle[1]);

    // Try to isolate main content container
    let bodyHtml = html;
    const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
    if (articleMatch && articleMatch[1].length > 300) {
      bodyHtml = articleMatch[1];
    } else {
      const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
      if (mainMatch && mainMatch[1].length > 300) bodyHtml = mainMatch[1];
    }

    // Remove noise
    let cleaned = bodyHtml
      .replace(/<head[\s\S]*?<\/head>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<aside[\s\S]*?<\/aside>/gi, '')
      .replace(/<form[\s\S]*?<\/form>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      // Turn structural block elements into paragraph breaks
      .replace(/<\/?(h[1-6]|p|li|div|section|article|blockquote|pre)[^>]*>/gi, '\n\n')
      .replace(/<br\s*\/?>/gi, '\n')
      // Strip remaining tags
      .replace(/<[^>]+>/g, ' ')
      // Decode common entities
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&[a-z]+;/gi, ' ')
      // Collapse whitespace
      .replace(/\s+/g, ' ')
      .trim();

    // Final safety cap
    cleaned = cleaned.slice(0, 180_000);

    const finalTitle = title || new URL(baseUrl).hostname;
    return { title: finalTitle, text: cleaned };
  }

  private cleanText(s: string): string {
    return s.replace(/\s+/g, ' ').trim();
  }
}

function defaultTitle(req: PublicIngestRequest): string {
  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
  if (req.format === 'markdown') return `Pasted markdown — ${stamp}`;
  if (req.format === 'url') return `Web page — ${stamp}`;
  return `Pasted text — ${stamp}`;
}
