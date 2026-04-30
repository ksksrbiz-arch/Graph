import { BadRequestException, Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { RevenueInflowInput } from '@pkg/shared';
import { ArcService } from './arc.service';

class ArcJsonIngestDto {
  userId!: string;
  inflows!: RevenueInflowInput[];
}

class ArcBankCsvDto {
  userId!: string;
  csv!: string;
}

@ApiTags('arc')
@Controller('arc')
@Throttle({ default: { ttl: 60_000, limit: 30 } })
export class ArcController {
  constructor(private readonly arc: ArcService) {}

  @Get('health')
  @ApiOperation({ summary: 'Probe whether ARC demo ingest is available' })
  health(): { ok: boolean; enabled: boolean; sources: string[] } {
    return this.arc.health();
  }

  @Get('summary')
  @ApiOperation({ summary: 'Summarize ARC revenue inflows, queue, and reconciliation state' })
  summary(@Query('userId') userId?: string): Promise<Record<string, unknown>> {
    if (!userId) throw new BadRequestException('userId query param is required');
    return this.arc.summary(userId);
  }

  @Get('queue')
  @ApiOperation({ summary: 'List pending ARC deposit proposals' })
  queue(@Query('userId') userId?: string): Promise<Array<Record<string, unknown>>> {
    if (!userId) throw new BadRequestException('userId query param is required');
    return this.arc.queue(userId);
  }

  @Get('inflows')
  @ApiOperation({ summary: 'List recent revenue inflows' })
  inflows(
    @Query('userId') userId?: string,
    @Query('limit') limit = '50',
  ): Promise<Array<Record<string, unknown>>> {
    if (!userId) throw new BadRequestException('userId query param is required');
    return this.arc.inflows(userId, Number(limit));
  }

  @Get('clients')
  @ApiOperation({ summary: 'List ARC clients discovered in the graph' })
  clients(@Query('userId') userId?: string): Promise<Array<Record<string, unknown>>> {
    if (!userId) throw new BadRequestException('userId query param is required');
    return this.arc.clients(userId);
  }

  @Post('ingest/json')
  @HttpCode(200)
  @ApiOperation({ summary: 'Ingest JSON ARC revenue inflows' })
  ingestJson(@Body() dto: ArcJsonIngestDto): Promise<{ imported: number }> {
    if (!dto?.userId) throw new BadRequestException('userId is required');
    if (!Array.isArray(dto.inflows) || dto.inflows.length === 0) {
      throw new BadRequestException('inflows[] is required');
    }
    return this.arc.ingestJson(dto.userId, dto.inflows);
  }

  @Post('ingest/bank-csv')
  @HttpCode(200)
  @ApiOperation({ summary: 'Ingest bank CSV rows into ARC' })
  ingestBankCsv(@Body() dto: ArcBankCsvDto): Promise<{ imported: number; matched: number }> {
    if (!dto?.userId) throw new BadRequestException('userId is required');
    if (typeof dto.csv !== 'string' || dto.csv.trim().length === 0) {
      throw new BadRequestException('csv is required');
    }
    return this.arc.ingestBankCsv(dto.userId, dto.csv);
  }
}
