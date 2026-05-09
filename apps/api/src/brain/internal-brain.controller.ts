import { BadRequestException, Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ServiceAuthGuard,
  type ServiceAuthedRequest,
} from '../auth/guards/service-auth.guard';
import { AttentionService } from './attention.service';
import { BrainRuntimeService } from './brain-runtime.service';
import { RecallService } from './recall.service';

interface InternalBrainDto {
  userId?: string;
  tenantId?: string;
}

interface ContextPackageDto extends InternalBrainDto {
  question?: string;
  topK?: number;
}

interface ObservationDto extends InternalBrainDto {
  intent?: string;
  ok?: boolean;
  result?: unknown;
  error?: string;
}

@ApiTags('brain-internal')
@ApiBearerAuth()
@UseGuards(ServiceAuthGuard)
@Controller('brain/internal')
export class InternalBrainController {
  constructor(
    private readonly runtime: BrainRuntimeService,
    private readonly attention: AttentionService,
    private readonly recall: RecallService,
  ) {}

  @Post('context-package')
  @ApiOperation({ summary: 'Deterministic context package for Worker reasoning' })
  async contextPackage(
    @Req() req: ServiceAuthedRequest,
    @Body() dto: ContextPackageDto = {},
  ) {
    this.assertTenant(req, dto);
    const userId = dto.userId || req.serviceAuth.sub;
    return {
      tenantId: req.serviceAuth.tenantId,
      userId,
      runtime: await this.runtime.status(userId),
      attention: this.attention.current(userId),
      memories: this.recall.recall(userId, { limit: dto.topK ?? 10 }),
    };
  }

  @Post('neural-state')
  @ApiOperation({ summary: 'Deterministic brain runtime and attention state' })
  async neuralState(
    @Req() req: ServiceAuthedRequest,
    @Body() dto: InternalBrainDto = {},
  ) {
    this.assertTenant(req, dto);
    const userId = dto.userId || req.serviceAuth.sub;
    return {
      tenantId: req.serviceAuth.tenantId,
      userId,
      runtime: await this.runtime.status(userId),
      attention: this.attention.current(userId),
    };
  }

  @Post('observations')
  @ApiOperation({ summary: 'Apply Worker tool-observation feedback to brain state' })
  async observation(
    @Req() req: ServiceAuthedRequest,
    @Body() dto: ObservationDto = {},
  ) {
    this.assertTenant(req, dto);
    const userId = dto.userId || req.serviceAuth.sub;
    if (dto.intent) {
      try {
        await this.attention.focus(userId, dto.intent, {
          durationMs: dto.ok ? 5_000 : 2_000,
          pulseCurrent: dto.ok ? 18 : 8,
        });
      } catch {
        // Observation feedback should never fail the Worker reasoning loop.
      }
    }
    return { ok: true, tenantId: req.serviceAuth.tenantId, userId };
  }

  private assertTenant(req: ServiceAuthedRequest, dto: InternalBrainDto): void {
    if (dto.tenantId && dto.tenantId !== req.serviceAuth.tenantId) {
      throw new BadRequestException('tenant claim mismatch');
    }
  }
}
