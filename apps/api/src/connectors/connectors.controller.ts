// Connector management — list configured connectors, toggle them, and
// trigger an out-of-band sync. The sync trigger is delegated to
// SyncOrchestrator so this controller stays thin (and so manual + scheduled
// syncs share one code path).

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
  forwardRef,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CONNECTOR_IDS, type ConnectorId, type ConnectorConfig } from '@pkg/shared';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CredentialCipher } from '../shared/crypto/credential-cipher';
import { Idempotent } from '../shared/idempotency/idempotency.interceptor';
import { SyncOrchestrator } from '../sync/sync.orchestrator';
import { ConnectorConfigStore } from './connector-config.store';
import { ConnectorRegistry } from './connector-registry';

interface AuthedRequest extends Request {
  user: { sub: string };
}

class UpdateConnectorDto {
  enabled?: boolean;
  syncIntervalMinutes?: number;
}

class ConfigureConnectorDto {
  @ApiProperty({ description: 'API key for the connector (e.g. sk-… for OpenAI)' })
  apiKey!: string;

  @ApiProperty({
    description: 'Optional extra settings stored alongside the key (e.g. groupId for Zotero)',
    required: false,
  })
  metadata?: Record<string, string>;
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
    private readonly cipher: CredentialCipher,
    private readonly registry: ConnectorRegistry,
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

  @Post(':id/configure')
  @HttpCode(201)
  @ApiOperation({
    summary:
      'Configure an API-key connector — stores the encrypted key and triggers an immediate sync; poll GET /connectors for updated sync status',
  })
  configure(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() dto: ConfigureConnectorDto,
  ): ConnectorSummary {
    const cid = assertConnectorId(id);

    // Only connectors that use API keys (not OAuth) may be configured this way.
    if (!this.registry.has(cid)) {
      throw new NotFoundException(
        `connector ${cid} has no implementation — it cannot be configured via this endpoint`,
      );
    }
    const connector = this.registry.get(cid);
    if (connector.authType !== 'apikey') {
      throw new BadRequestException(
        `connector ${cid} uses OAuth — use POST /oauth/connect/${cid} instead`,
      );
    }

    if (!dto.apiKey?.trim()) {
      throw new BadRequestException('apiKey is required');
    }

    const credentialPayload: Record<string, unknown> = {
      accessToken: dto.apiKey.trim(),
      ...(dto.metadata ?? {}),
    };
    const credentials = this.cipher.encrypt(JSON.stringify(credentialPayload));

    const existing = this.configs.find(req.user.sub, cid);
    const config: ConnectorConfig = {
      id: cid,
      userId: req.user.sub,
      enabled: true,
      credentials,
      syncIntervalMinutes: existing?.syncIntervalMinutes ?? 30,
    };

    // Upsert triggers the SyncScheduler's subscribe listener which immediately
    // enqueues a sync — no extra trigger call needed here.
    const saved = this.configs.upsert(config);
    return toSummary(saved, true);
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
