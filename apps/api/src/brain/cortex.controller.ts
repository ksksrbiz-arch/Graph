// REST surface for the deterministic cortex pipeline. POST /brain/cortex/think
// runs the six-phase pipeline (sensory → memory → limbic → association →
// executive → motor) over the user's knowledge graph and live brain state and
// returns a structured `Thought`. The brain physically reverberates around the
// answer when `enact=true`.

import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Idempotent } from '../shared/idempotency/idempotency.interceptor';
import { CortexService, type CortexThinkResult } from './cortex.service';

interface AuthedRequest extends Request {
  user: { sub: string };
}

interface ThinkDto {
  question?: string;
  graphLimit?: number;
  memoryLimit?: number;
  maxAssociationDepth?: number;
  enact?: boolean;
}

@ApiTags('brain-cortex')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('brain/cortex')
export class CortexController {
  constructor(private readonly cortex: CortexService) {}

  @Post('think')
  @ApiOperation({
    summary:
      'Run the deterministic cortex pipeline over the user graph. Returns a structured Thought (seeds + memories + reasoning paths + conclusion + proposed actions).',
  })
  @Idempotent()
  think(
    @Req() req: AuthedRequest,
    @Body() dto: ThinkDto = {},
  ): Promise<CortexThinkResult> {
    return this.cortex.think(req.user.sub, {
      ...(dto.question !== undefined ? { question: dto.question } : {}),
      ...(dto.graphLimit !== undefined ? { graphLimit: dto.graphLimit } : {}),
      ...(dto.memoryLimit !== undefined ? { memoryLimit: dto.memoryLimit } : {}),
      ...(dto.maxAssociationDepth !== undefined
        ? { maxAssociationDepth: dto.maxAssociationDepth }
        : {}),
      ...(dto.enact !== undefined ? { enact: dto.enact } : {}),
    });
  }
}
