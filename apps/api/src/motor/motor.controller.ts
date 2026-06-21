// REST surface for the safety kernel. Phase 0 exposes raw evaluate() +
// recent decisions for testing / dashboards; Phase 1 adds the
// human-approval queue (list pending + approve/reject).

import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  ApprovalQueueService,
  type ActionDecision,
  type PendingAction,
} from './approval-queue.service';
import {
  SafetySupervisor,
  type MotorIntent,
  type SafetyVerdict,
  type SupervisorDecision,
} from './safety-supervisor';

interface AuthedRequest extends Request {
  user: { sub: string };
}

class DecideDto {
  @IsIn(['approve', 'reject'])
  decision!: ActionDecision;

  @IsOptional()
  @IsString()
  note?: string;
}

@ApiTags('motor')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('motor')
export class MotorController {
  constructor(
    private readonly supervisor: SafetySupervisor,
    private readonly queue: ApprovalQueueService,
  ) {}

  @Post('evaluate')
  @ApiOperation({ summary: 'Run a candidate motor intent through the safety kernel' })
  evaluate(@Body() intent: MotorIntent): SafetyVerdict {
    return this.supervisor.evaluate(intent);
  }

  @Get('recent')
  @ApiOperation({ summary: 'Last N supervisor decisions' })
  recent(): SupervisorDecision[] {
    return this.supervisor.recentDecisions(50);
  }

  @Get('queue')
  @ApiOperation({ summary: 'List pending motor actions awaiting approval' })
  queuePending(@Req() req: AuthedRequest): Promise<PendingAction[]> {
    return this.queue.listPending(req.user.sub);
  }

  @Post('decide/:id')
  @ApiOperation({ summary: 'Approve or reject a pending motor action' })
  decide(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: DecideDto,
  ): Promise<PendingAction> {
    return this.queue.decide(req.user.sub, id, dto.decision, dto.note);
  }
}
