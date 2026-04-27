import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { BrainService } from './brain.service.js';

// Phase 0: open. Phase 1 reintroduces JwtAuthGuard + per-user scoping
// (currently every request operates on the single demo user).
const DEMO_USER = '00000000-0000-4000-8000-000000000001';

@ApiTags('brain')
@Controller('brain')
export class BrainController {
  constructor(private readonly svc: BrainService) {}

  @Post('start')
  @ApiOperation({ summary: 'Boot the simulator for the current user' })
  async start() {
    return this.svc.start(DEMO_USER);
  }

  @Delete('stop')
  @ApiOperation({ summary: 'Halt the simulator for the current user' })
  async stop() {
    return { stopped: this.svc.stop(DEMO_USER) };
  }

  @Get('status')
  @ApiOperation({ summary: 'Sim status: running flag + neuron/synapse counts + sim time' })
  status() {
    return this.svc.status(DEMO_USER);
  }

  @Post('stimulate/:neuronId')
  @ApiOperation({ summary: 'Inject a stimulation current into a neuron' })
  async stimulate(
    @Param('neuronId') neuronId: string,
    @Body() body: { current?: number } = {},
  ) {
    return { ok: this.svc.stimulate(DEMO_USER, neuronId, body.current ?? 30) };
  }
}
