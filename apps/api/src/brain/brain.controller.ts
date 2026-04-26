// REST endpoints for brain lifecycle. The actual spike stream is delivered
// over the `/brain` Socket.IO namespace (see brain.gateway.ts) — these routes
// just start/stop simulators and inject ad-hoc stimuli.

import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { BrainService } from './brain.service';

interface AuthedRequest extends Request {
  user: { sub: string };
}

@ApiTags('brain')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('brain')
export class BrainController {
  constructor(private readonly brain: BrainService) {}

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
}
