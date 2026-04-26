// Connector management — list configured connectors, toggle them, and
// trigger an out-of-band sync. The sync trigger is delegated to
// SyncOrchestrator so this controller stays thin (and so manual + scheduled
// syncs share one code path).

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
  forwardRef,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CONNECTOR_IDS, type ConnectorId, type ConnectorConfig } from '@pkg/shared';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Idempotent } from '../shared/idempotency/idempotency.interceptor';
import { SyncOrchestrator } from '../sync/sync.orchestrator';
import { ConnectorConfigStore } from './connector-config.store';

interface AuthedRequest extends Request {
  user: { sub: string };
}

class UpdateConnectorDto {
  enabled?: boolean;
  syncIntervalMinutes?: number;
}

interface ConnectorSummary {
  id: ConnectorId;
  enabled: boolean;
  syncIntervalMinutes: number;
  lastSyncAt: string | undefined;
  lastSyncStatus: ConnectorConfig['lastSyncStatus'];
  rateLimitRemaining: number | undefined;
  rateLimitResetsAt: string | undefined;
  configured: boolean;
}

@ApiTags('connectors')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('connectors')
export class ConnectorsController {
  constructor(
    private readonly configs: ConnectorConfigStore,
    @Inject(forwardRef(() => SyncOrchestrator))
    private readonly sync: SyncOrchestrator,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List connector configs for the authed user' })
  list(@Req() req: AuthedRequest): ConnectorSummary[] {
    const userId = req.user.sub;
    const byId = new Map<ConnectorId, ConnectorConfig>();
    for (const c of this.configs.listForUser(userId)) byId.set(c.id, c);

    return CONNECTOR_IDS.map((id) => {
      const c = byId.get(id);
      return c
        ? toSummary(c, true)
        : {
            id,
            enabled: false,
            syncIntervalMinutes: 30,
            lastSyncAt: undefined,
            lastSyncStatus: undefined,
            rateLimitRemaining: undefined,
            rateLimitResetsAt: undefined,
            configured: false,
          };
    });
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Enable/disable or change sync interval' })
  update(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() dto: UpdateConnectorDto,
  ): ConnectorSummary {
    const cid = assertConnectorId(id);
    const existing = this.configs.find(req.user.sub, cid);
    if (!existing) {
      throw new Error(`connector ${cid} is not configured for this user`);
    }
    const updated = this.configs.upsert({
      ...existing,
      ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
      ...(dto.syncIntervalMinutes !== undefined
        ? { syncIntervalMinutes: dto.syncIntervalMinutes }
        : {}),
    });
    return toSummary(updated, true);
  }

  @Post(':id/sync')
  @HttpCode(202)
  @Idempotent()
  @ApiOperation({ summary: 'Trigger a manual sync — runs in the background' })
  triggerSync(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
  ): { jobId: string } {
    const cid = assertConnectorId(id);
    const jobId = this.sync.enqueue({ userId: req.user.sub, connectorId: cid });
    return { jobId };
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove the connector config (revokes locally)' })
  remove(@Req() req: AuthedRequest, @Param('id') id: string): void {
    const cid = assertConnectorId(id);
    this.configs.remove(req.user.sub, cid);
  }
}

function toSummary(config: ConnectorConfig, configured: boolean): ConnectorSummary {
  return {
    id: config.id,
    enabled: config.enabled,
    syncIntervalMinutes: config.syncIntervalMinutes,
    lastSyncAt: config.lastSyncAt,
    lastSyncStatus: config.lastSyncStatus,
    rateLimitRemaining: config.rateLimitRemaining,
    rateLimitResetsAt: config.rateLimitResetsAt,
    configured,
  };
}

function assertConnectorId(value: string): ConnectorId {
  if (!(CONNECTOR_IDS as readonly string[]).includes(value)) {
    throw new Error(`unknown connectorId: ${value}`);
  }
  return value as ConnectorId;
}
