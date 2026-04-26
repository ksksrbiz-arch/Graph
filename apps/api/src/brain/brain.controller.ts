// REST endpoints for brain lifecycle. The actual spike stream is delivered
// over the `/brain` Socket.IO namespace (see brain.gateway.ts) — these routes
// just start/stop simulators and inject ad-hoc stimuli.

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AttentionService, type AttentionFocus } from './attention.service';
import { BrainService } from './brain.service';
import { DreamService, type DreamStatus } from './dream.service';
import { SensoryService } from './sensory.service';

interface AuthedRequest extends Request {
  user: { sub: string };
}

@ApiTags('brain')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('brain')
export class BrainController {
  constructor(
    private readonly brain: BrainService,
    private readonly sensory: SensoryService,
    private readonly attention: AttentionService,
    private readonly dream: DreamService,
  ) {}

  @Post('start')
  start(@Req() req: AuthedRequest): Promise<{ neurons: number; synapses: number }> {
    return this.brain.start(req.user.sub);
  }

  @Delete('stop')
  @HttpCode(204)
  stop(@Req() req: AuthedRequest): void {
    this.brain.stop(req.user.sub);
  }

  @Post('stimulate/:neuronId')
  @HttpCode(204)
  stimulate(
    @Req() req: AuthedRequest,
    @Param('neuronId') neuronId: string,
    @Body('currentMv') currentMv?: number,
  ): void {
    this.brain.stimulate(req.user.sub, neuronId, currentMv);
  }

  @Post('checkpoint')
  @ApiOperation({ summary: 'Force-flush learned synaptic weights to Neo4j' })
  checkpoint(
    @Req() req: AuthedRequest,
  ): Promise<{ persisted: number; skipped: number }> {
    return this.brain.checkpoint(req.user.sub);
  }

  @Post('perceive/:neuronId')
  @ApiOperation({ summary: 'Fire a node as if a connector just observed it' })
  perceive(
    @Req() req: AuthedRequest,
    @Param('neuronId') neuronId: string,
  ): { ok: true } {
    // Phase 0: synthesise a sensory pulse for an arbitrary node id. Phase 4+
    // connectors will call SensoryService.perceive() directly with the real
    // KGNode they just ingested.
    this.sensory.perceive(req.user.sub, {
      id: neuronId,
      type: 'email',
      sourceId: 'gmail',
    });
    return { ok: true };
  }

  @Post('attend')
  @ApiOperation({ summary: 'Direct the brain to focus on neurons matching a query' })
  attend(
    @Req() req: AuthedRequest,
    @Body() dto: { query: string; durationMs?: number; pulseCurrent?: number },
  ): Promise<AttentionFocus> {
    return this.attention.focus(req.user.sub, dto.query, {
      ...(dto.durationMs ? { durationMs: dto.durationMs } : {}),
      ...(dto.pulseCurrent ? { pulseCurrent: dto.pulseCurrent } : {}),
    });
  }

  @Delete('attend')
  @ApiOperation({ summary: 'Clear current attention focus' })
  unattend(@Req() req: AuthedRequest): { cleared: boolean } {
    return { cleared: this.attention.unfocus(req.user.sub) };
  }

  @Get('attend')
  @ApiOperation({ summary: 'Current attention focus, if any' })
  attentionStatus(
    @Req() req: AuthedRequest,
  ): AttentionFocus | { query: null } {
    return this.attention.current(req.user.sub) ?? { query: null };
  }

  @Post('dream/start')
  @ApiOperation({ summary: 'Begin the awake/sleep dream cycle' })
  dreamStart(
    @Req() req: AuthedRequest,
    @Body() dto: { awakeMs?: number; dreamMs?: number },
  ): DreamStatus {
    return this.dream.start(req.user.sub, dto ?? {});
  }

  @Delete('dream/stop')
  @ApiOperation({ summary: 'Stop the dream cycle' })
  dreamStop(@Req() req: AuthedRequest): { stopped: boolean } {
    return { stopped: this.dream.stop(req.user.sub) };
  }

  @Get('dream/status')
  @ApiOperation({ summary: 'Current dream phase + cycle timing' })
  dreamStatus(
    @Req() req: AuthedRequest,
  ): DreamStatus | { phase: null } {
    return this.dream.status(req.user.sub) ?? { phase: null };
  }

  @Post('dream/trigger')
  @ApiOperation({ summary: 'Force an immediate sleep phase' })
  dreamTrigger(
    @Req() req: AuthedRequest,
    @Body() dto: { dreamMs?: number },
  ): { triggered: boolean } {
    return this.dream.triggerDream(req.user.sub, dto?.dreamMs);
  }
}
