// Brain Insights REST surface. Live numbers — region activity, top pathways,
// pathway-formation history, connectome growth — that the SPA paints into a
// dashboard. The same metrics ride the /brain WebSocket as periodic pushes
// (see BrainGateway), but the GET endpoints exist so a fresh page load can
// hydrate without waiting for the next tick.

import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { InsightsService } from './insights.service';
import type {
  BrainInsightsSummary,
  ConnectomeSnapshot,
  PathwayFormationEvent,
  PathwaySummary,
  RegionActivity,
} from './insights.types';

interface AuthedRequest extends Request {
  user: { sub: string };
}

@ApiTags('brain-insights')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('brain/insights')
export class InsightsController {
  constructor(private readonly insights: InsightsService) {}

  @Get('summary')
  @ApiOperation({
    summary:
      'Combined dashboard payload: regions + top pathways + formations + growth',
  })
  summary(
    @Req() req: AuthedRequest,
    @Query('topN') topN?: string,
  ): BrainInsightsSummary {
    const parsed = topN ? parseInt(topN, 10) : undefined;
    return this.insights.summary(req.user.sub, {
      ...(parsed && Number.isFinite(parsed) ? { topN: parsed } : {}),
    });
  }

  @Get('regions')
  @ApiOperation({ summary: 'Per-region spike-rate histogram (last 30s)' })
  regions(@Req() req: AuthedRequest): RegionActivity[] {
    return this.insights.regions(req.user.sub);
  }

  @Get('pathways')
  @ApiOperation({
    summary:
      'Top pathways. sort=strongest|growing|decaying — defaults to strongest.',
  })
  pathways(
    @Req() req: AuthedRequest,
    @Query('sort') sort = 'strongest',
    @Query('topN') topN?: string,
  ): PathwaySummary[] {
    const parsed = topN ? parseInt(topN, 10) : undefined;
    const summary = this.insights.summary(req.user.sub, {
      ...(parsed && Number.isFinite(parsed) ? { topN: parsed } : {}),
    });
    if (sort === 'growing') return summary.growingPathways;
    if (sort === 'decaying') return summary.decayingPathways;
    return summary.strongestPathways;
  }

  @Get('formations')
  @ApiOperation({
    summary: 'Synapses that recently crossed the pathway-formation threshold',
  })
  formations(@Req() req: AuthedRequest): PathwayFormationEvent[] {
    return this.insights.summary(req.user.sub, { topN: 50 }).recentFormations;
  }

  @Get('growth')
  @ApiOperation({ summary: 'Connectome size + mean weight, sampled per minute' })
  growth(@Req() req: AuthedRequest): ConnectomeSnapshot[] {
    return this.insights.summary(req.user.sub).growth;
  }
}
