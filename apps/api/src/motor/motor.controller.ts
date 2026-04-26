// REST surface for the safety kernel. Phase 0 exposes raw evaluate() +
// recent decisions for testing / dashboards; Phase 1+ will add the
// human-approval queue and async dispatch endpoints.

import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  SafetySupervisor,
  type MotorIntent,
  type SafetyVerdict,
  type SupervisorDecision,
} from './safety-supervisor';

@ApiTags('motor')
@Controller('motor')
export class MotorController {
  constructor(private readonly supervisor: SafetySupervisor) {}

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
}
