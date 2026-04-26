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
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Idempotent } from '../shared/idempotency/idempotency.interceptor';
import { AttentionService, type AttentionFocus } from './attention.service';
import { BrainRuntimeService, type BrainRuntimeStatus } from './brain-runtime.service';
import { BrainService } from './brain.service';
import { DreamService, type DreamStatus } from './dream.service';
import { RecallService, type MemoryRecord } from './recall.service';
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
    private readonly runtime: BrainRuntimeService,
    private readonly brain: BrainService,
    private readonly sensory: SensoryService,
    private readonly attention: AttentionService,
    private readonly dream: DreamService,
    private readonly recall: RecallService,
  ) {}

  @Post('start')
  @Idempotent()
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'Optional client token to dedupe rapid retries of brain start.',
  })
  start(@Req() req: AuthedRequest): Promise<{ neurons: number; synapses: number }> {
    return this.runtime.start(req.user.sub).then((summary) => summary ?? { neurons: 0, synapses: 0 });
  }

  @Delete('stop')
  @HttpCode(204)
  async stop(@Req() req: AuthedRequest): Promise<void> {
    await this.runtime.stop(req.user.sub);
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
  @Idempotent()
  checkpoint(
    @Req() req: AuthedRequest,
  ): Promise<{ persisted: number; skipped: number }> {
    return this.runtime.checkpoint(req.user.sub);
  }

  @Get('runtime')
  @ApiOperation({ summary: 'Hosted runtime status for the current user brain' })
  runtimeStatus(@Req() req: AuthedRequest): Promise<BrainRuntimeStatus> {
    return this.runtime.status(req.user.sub);
  }

  @Post('perceive/:neuronId')
  @ApiOperation({ summary: 'Fire a node as if a connector just observed it' })
  @Idempotent()
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
  @Idempotent()
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
  @Idempotent()
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

  @Get('recall')
  @ApiOperation({
    summary: 'Top memories — pairs of neurons that consistently fire together',
  })
  recallMemories(
    @Req() req: AuthedRequest,
    @Query('neuronId') neuronId?: string,
    @Query('limit') limit = '20',
  ): MemoryRecord[] {
    const parsed = parseInt(limit, 10);
    return this.recall.recall(req.user.sub, {
      ...(neuronId ? { neuronId } : {}),
      limit: Number.isFinite(parsed) && parsed > 0 ? parsed : 20,
    });
  }
}
