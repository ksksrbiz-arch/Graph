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
import {
  PublicIngestService,
  type PublicIngestResult,
} from './public-ingest.service';

const TEXT_MAX_LENGTH = 200_000;

class IngestTextDto {
  userId!: string;
  text!: string;
  title?: string;
}

class IngestMarkdownDto {
  userId!: string;
  markdown!: string;
  title?: string;
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
      formats: ['text', 'markdown'],
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

  @Get('graph')
  @ApiOperation({ summary: 'Snapshot the demo userId graph (Neo4j → JSON)' })
  graph(@Query('userId') userId?: string): Promise<unknown> {
    if (!userId) throw new BadRequestException('userId query param is required');
    return this.ingest.snapshot(userId);
  }
}

function requireString(dto: Record<string, unknown>, field: string): void {
  const value = dto[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestException(`${field} is required`);
  }
}
