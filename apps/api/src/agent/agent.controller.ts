// REST surface for the autonomous cortex agent. Four operations:
//
//   POST /agent/run                 — run one autonomous cycle (think + act)
//   GET  /agent/tools               — list the agent's tool catalog
//   GET  /agent/sources             — list configured data sources
//   POST /agent/ingest/:connectorId — trigger a permitted ingest
//   POST /agent/predict-links/:nodeId — surface predicted links
//
//   GET  /agent/permissions         — list the user's grants
//   POST /agent/permissions         — grant a scope to the agent
//   DELETE /agent/permissions/:scope — revoke a previously-granted scope
//
// Every action goes through AgentService → permission store → audit log.

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { ConnectorId } from '@pkg/shared';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Idempotent } from '../shared/idempotency/idempotency.interceptor';
import {
  AgentPermissionStore,
  type AgentPermissionGrant,
  type AgentPermissionScope,
} from './agent-permission.store';
import {
  AgentService,
  type AgentRunReport,
  type AgentStepRecord,
  type AgentToolDescriptor,
} from './agent.service';

interface AuthedRequest extends Request {
  user: { sub: string };
}

interface RunDto {
  question?: string;
  maxSteps?: number;
}

interface GrantDto {
  scope: AgentPermissionScope;
  expiresAt?: string | null;
}

@ApiTags('agent')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('agent')
export class AgentController {
  constructor(
    private readonly agent: AgentService,
    private readonly permissions: AgentPermissionStore,
  ) {}

  @Post('run')
  @ApiOperation({
    summary: 'Run one autonomous agent cycle: think, then enact every motor action permitted.',
  })
  @Idempotent()
  run(@Req() req: AuthedRequest, @Body() dto: RunDto = {}): Promise<AgentRunReport> {
    return this.agent.run(req.user.sub, {
      ...(dto.question !== undefined ? { question: dto.question } : {}),
      ...(dto.maxSteps !== undefined ? { maxSteps: dto.maxSteps } : {}),
    });
  }

  @Get('tools')
  @ApiOperation({ summary: 'Catalog of tools the agent can invoke + the permission each requires.' })
  tools(): AgentToolDescriptor[] {
    return this.agent.tools();
  }

  @Get('sources')
  @ApiOperation({ summary: 'Data sources the user has configured.' })
  sources(@Req() req: AuthedRequest) {
    return this.agent.listDataSources(req.user.sub);
  }

  @Post('ingest/:connectorId')
  @ApiOperation({
    summary: 'Ask the agent to ingest from a specific connector. Requires agent:ingest:<id>.',
  })
  @Idempotent()
  ingest(
    @Req() req: AuthedRequest,
    @Param('connectorId') connectorId: string,
  ): Promise<AgentStepRecord> {
    return this.agent.ingestFrom(req.user.sub, connectorId as ConnectorId);
  }

  @Post('predict-links/:nodeId')
  @ApiOperation({
    summary: 'Ask the agent to surface predicted links for a node. Requires agent:predict-links.',
  })
  predictLinks(
    @Req() req: AuthedRequest,
    @Param('nodeId') nodeId: string,
  ): Promise<AgentStepRecord> {
    return this.agent.predictLinks(req.user.sub, nodeId);
  }

  @Get('permissions')
  @ApiOperation({ summary: 'List the unexpired permission grants for the current user.' })
  list(@Req() req: AuthedRequest): AgentPermissionGrant[] {
    return this.permissions.list(req.user.sub);
  }

  @Post('permissions')
  @ApiOperation({ summary: 'Grant the agent a permission scope.' })
  grant(@Req() req: AuthedRequest, @Body() dto: GrantDto): AgentPermissionGrant {
    return this.permissions.grant(req.user.sub, dto.scope, {
      ...(dto.expiresAt !== undefined ? { expiresAt: dto.expiresAt } : {}),
    });
  }

  @Delete('permissions/:scope')
  @ApiOperation({ summary: 'Revoke a previously-granted permission scope.' })
  revoke(
    @Req() req: AuthedRequest,
    @Param('scope') scope: string,
  ): { revoked: boolean } {
    return {
      revoked: this.permissions.revoke(req.user.sub, scope as AgentPermissionScope),
    };
  }
}
