// REST surface for the cerebral stream — the autonomous thought layer that
// turns live brain events (formations / perceives / focus / dreams) into
// cortex passes. The thoughts are streamed to clients over the /brain
// WebSocket as `thought` events; these REST routes are for hydration on
// reconnect and for the SPA's "think now" button.

import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  CerebralStreamService,
  type CerebralThoughtEvent,
  type CerebralTrigger,
} from './cerebral-stream.service';

interface AuthedRequest extends Request {
  user: { sub: string };
}

interface FireDto {
  reason?: string;
  question?: string;
}

const ALLOWED_TRIGGERS: ReadonlySet<CerebralTrigger> = new Set([
  'formation',
  'perceive',
  'attention',
  'dream',
]);

@ApiTags('brain-cerebral')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('brain/cerebral')
export class CerebralStreamController {
  constructor(private readonly stream: CerebralStreamService) {}

  @Get('recent')
  @ApiOperation({
    summary: 'Recent autonomous thoughts triggered by the brain itself',
  })
  recent(
    @Req() req: AuthedRequest,
    @Query('limit') limit = '10',
  ): CerebralThoughtEvent[] {
    const parsed = parseInt(limit, 10);
    return this.stream.recent(
      req.user.sub,
      Number.isFinite(parsed) && parsed > 0 ? parsed : 10,
    );
  }

  @Post('fire')
  @ApiOperation({
    summary:
      'Force an immediate cortex pass for the current user. Optional trigger label + question.',
  })
  async fire(
    @Req() req: AuthedRequest,
    @Body() dto: FireDto & { trigger?: string } = {},
  ): Promise<CerebralThoughtEvent | { fired: false }> {
    const trigger: CerebralTrigger = ALLOWED_TRIGGERS.has(dto.trigger as CerebralTrigger)
      ? (dto.trigger as CerebralTrigger)
      : 'attention';
    const reason = dto.reason?.trim() || 'manual fire from /cerebral/fire';
    const result = await this.stream.fire(
      req.user.sub,
      trigger,
      reason,
      dto.question,
    );
    return result ?? { fired: false };
  }
}
