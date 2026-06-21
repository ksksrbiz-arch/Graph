// Anonymous, allowlisted ingest endpoints for the demo deployment. The
// website on Cloudflare posts here so a visitor can paste text/markdown,
// have it parsed into KGNodes, persisted to Neo4j, and shown in the brain
// dashboard within seconds. Wider, multi-tenant ingest still flows through
// the JWT-guarded /connectors and /sync endpoints (Phases 1+).

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsArray, IsOptional, IsString } from 'class-validator';
import {
  PublicIngestService,
  type GraphIngestResult,
  type PublicIngestResult,
} from './public-ingest.service';

const TEXT_MAX_LENGTH = 200_000;
const GRAPH_MAX_NODES = 5_000;
const GRAPH_MAX_EDGES = 20_000;

// The global ValidationPipe runs with `whitelist: true`, which strips any
// property that has no class-validator decorator. These DTOs must therefore
// decorate every field they expect to receive, or the body arrives empty.
class IngestTextDto {
  @IsString() userId!: string;
  @IsString() text!: string;
  @IsOptional() @IsString() title?: string;
}

class IngestMarkdownDto {
  @IsString() userId!: string;
  @IsString() markdown!: string;
  @IsOptional() @IsString() title?: string;
}

class IngestUrlDto {
  @IsString() userId!: string;
  @IsString() url!: string;
  @IsOptional() @IsString() title?: string;
}

class IngestGraphDto {
  @IsString() userId!: string;
  @IsArray() nodes!: unknown[];
  @IsOptional() @IsArray() edges?: unknown[];
  @IsOptional() @IsString() sourceId?: string;
}

@ApiTags('public')
@Controller('public')
// Tighter ceiling than the global 100/min — ingest is more expensive than a
// regular API call and is anonymous, so abuse risk is higher.
@Throttle({ default: { ttl: 60_000, limit: 30 } })
export class PublicController {
  constructor(private readonly ingest: PublicIngestService) {}

  @Get('ingest/health')
  @ApiOperation({ summary: 'Probe whether public ingest is available' })
  health(): { ok: boolean; enabled: boolean; formats: string[] } {
    return {
      ok: true,
      enabled: this.ingest.isEnabled(),
      formats: ['text', 'markdown', 'url', 'graph'],
    };
  }

  @Post('ingest/text')
  @HttpCode(200)
  @ApiOperation({ summary: 'Paste a free-text blob; returns the parsed graph fragment' })
  ingestText(@Body() dto: IngestTextDto): Promise<PublicIngestResult> {
    requireString(dto as unknown as Record<string, unknown>, 'userId');
    requireString(dto as unknown as Record<string, unknown>, 'text');
    if (dto.text.length > TEXT_MAX_LENGTH) {
      throw new BadRequestException(`text exceeds ${TEXT_MAX_LENGTH} characters`);
    }
    return this.ingest.ingest({
      userId: dto.userId,
      format: 'text',
      content: dto.text,
      ...(dto.title ? { title: dto.title } : {}),
    });
  }

  @Post('ingest/markdown')
  @HttpCode(200)
  @ApiOperation({ summary: 'Paste a markdown document; parses headings + wikilinks' })
  ingestMarkdown(@Body() dto: IngestMarkdownDto): Promise<PublicIngestResult> {
    requireString(dto as unknown as Record<string, unknown>, 'userId');
    requireString(dto as unknown as Record<string, unknown>, 'markdown');
    if (dto.markdown.length > TEXT_MAX_LENGTH) {
      throw new BadRequestException(`markdown exceeds ${TEXT_MAX_LENGTH} characters`);
    }
    return this.ingest.ingest({
      userId: dto.userId,
      format: 'markdown',
      content: dto.markdown,
      ...(dto.title ? { title: dto.title } : {}),
    });
  }

  @Post('ingest/url')
  @HttpCode(200)
  @ApiOperation({ summary: 'Provide a public URL; server fetches, extracts main text, and ingests' })
  async ingestUrl(@Body() dto: IngestUrlDto): Promise<PublicIngestResult> {
    requireString(dto as unknown as Record<string, unknown>, 'userId');
    requireString(dto as unknown as Record<string, unknown>, 'url');
    // basic URL validation
    try { new URL(dto.url); } catch {
      throw new BadRequestException('url must be a valid http(s) URL');
    }
    return this.ingest.ingestUrl(dto.userId, dto.url, dto.title);
  }

  @Post('ingest/graph')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Ingest a pre-parsed {nodes, edges} fragment (batch folder upload)',
  })
  ingestGraph(@Body() dto: IngestGraphDto): Promise<GraphIngestResult> {
    requireString(dto as unknown as Record<string, unknown>, 'userId');
    if (!Array.isArray(dto.nodes) || dto.nodes.length === 0) {
      throw new BadRequestException('nodes must be a non-empty array');
    }
    if (dto.nodes.length > GRAPH_MAX_NODES) {
      throw new BadRequestException(`nodes exceeds ${GRAPH_MAX_NODES} per request`);
    }
    const edges = Array.isArray(dto.edges) ? dto.edges : [];
    if (edges.length > GRAPH_MAX_EDGES) {
      throw new BadRequestException(`edges exceeds ${GRAPH_MAX_EDGES} per request`);
    }
    // Allowlist gate (size is bounded by the node/edge caps above).
    this.ingest.assertAllowed(dto.userId, 0);
    return this.ingest.ingestGraph(dto.userId, dto.nodes, edges, dto.sourceId);
  }

  @Get('graph')
  @ApiOperation({ summary: 'Snapshot the demo userId graph (Neo4j → JSON)' })
  graph(@Query('userId') userId?: string): Promise<unknown> {
    if (!userId) throw new BadRequestException('userId query param is required');
    return this.ingest.snapshot(userId);
  }

  @Get('graph/delta')
  @ApiOperation({
    summary: 'Nodes + edges added since `since` (ISO-8601 or epoch ms)',
  })
  graphDelta(
    @Query('userId') userId?: string,
    @Query('since') since?: string,
  ): Promise<unknown> {
    if (!userId) throw new BadRequestException('userId query param is required');
    return this.ingest.snapshotDelta(userId, normalizeSince(since));
  }
}

/** Accept either an ISO-8601 string or a numeric epoch (ms) and return the ISO
 *  form Cypher compares against. Defaults to epoch — a missing `since` is
 *  treated as "give me everything", same as a fresh client. */
function normalizeSince(raw: string | undefined): string {
  if (!raw) return new Date(0).toISOString();
  if (/^\d+$/.test(raw)) {
    const ms = Number(raw);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException('since must be ISO-8601 or epoch milliseconds');
  }
  return parsed.toISOString();
}

function requireString(dto: Record<string, unknown>, field: string): void {
  const value = dto[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestException(`${field} is required`);
  }
}
