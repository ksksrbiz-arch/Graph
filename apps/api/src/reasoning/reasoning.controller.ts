// REST surface for the reasoning service. Reads only — no side effects, so no
// idempotency keys are required here. Mutating endpoints elsewhere (graph
// writes, brain perceive) are the ones that gain Idempotency-Key support.

import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { LinkPredictionMethod } from '@pkg/reasoning';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ReasoningService } from './reasoning.service';

interface AuthedRequest extends Request {
  user: { sub: string };
}

const ALLOWED_METHODS: ReadonlySet<LinkPredictionMethod> = new Set([
  'common-neighbours',
  'jaccard',
  'adamic-adar',
]);

@ApiTags('reasoning')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('reasoning')
export class ReasoningController {
  constructor(private readonly reasoning: ReasoningService) {}

  @Post('embed')
  @ApiOperation({ summary: 'Embed arbitrary text into the standard 384-dim vector' })
  embed(@Body() dto: { text: string }): { embedding: number[]; dim: number } {
    const embedding = this.reasoning.embedText(dto.text ?? '');
    return { embedding, dim: embedding.length };
  }

  @Post('classify')
  @ApiOperation({ summary: 'Classify a label/URL/connector tuple into a NodeType' })
  classify(
    @Body()
    dto: {
      label: string;
      url?: string;
      connector?: string;
      metadata?: Record<string, unknown>;
    },
  ) {
    return this.reasoning.classify({
      label: dto.label,
      ...(dto.url !== undefined ? { url: dto.url } : {}),
      ...(dto.connector !== undefined ? { connector: dto.connector } : {}),
      ...(dto.metadata !== undefined ? { metadata: dto.metadata } : {}),
    });
  }

  @Get('similar/:nodeId')
  @ApiOperation({ summary: 'Top-N nodes semantically similar to the given node' })
  similar(
    @Req() req: AuthedRequest,
    @Param('nodeId') nodeId: string,
    @Query('limit') limit = '10',
  ) {
    const parsed = parseInt(limit, 10);
    return this.reasoning.similarNodes(
      req.user.sub,
      nodeId,
      Number.isFinite(parsed) && parsed > 0 ? parsed : 10,
    );
  }

  @Get('predict-links/:nodeId')
  @ApiOperation({ summary: 'Top-N candidate links from the given node' })
  predictLinks(
    @Req() req: AuthedRequest,
    @Param('nodeId') nodeId: string,
    @Query('method') method = 'adamic-adar',
    @Query('limit') limit = '10',
  ) {
    if (!ALLOWED_METHODS.has(method as LinkPredictionMethod)) {
      throw new NotFoundException(`unknown method "${method}"`);
    }
    const parsed = parseInt(limit, 10);
    return this.reasoning.predictLinks(
      req.user.sub,
      nodeId,
      method as LinkPredictionMethod,
      Number.isFinite(parsed) && parsed > 0 ? parsed : 10,
    );
  }

  @Get('path')
  @ApiOperation({ summary: 'Strongest reasoning path between two nodes' })
  path(
    @Req() req: AuthedRequest,
    @Query('source') source: string,
    @Query('target') target: string,
    @Query('maxDepth') maxDepth = '4',
  ) {
    const parsed = parseInt(maxDepth, 10);
    return this.reasoning.reasoningPath(
      req.user.sub,
      source,
      target,
      Number.isFinite(parsed) && parsed > 0 ? parsed : 4,
    );
  }

  @Get('summary/:nodeId')
  @ApiOperation({ summary: 'Neighbourhood summary for the given node' })
  summary(@Req() req: AuthedRequest, @Param('nodeId') nodeId: string) {
    return this.reasoning.summarise(req.user.sub, nodeId);
  }
}
