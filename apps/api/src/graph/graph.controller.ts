// REST endpoints for graph access — spec §6.1 rows under /graph/*.
// All routes are guarded by JwtAuthGuard. Pagination is cursor-based (Rule 17).

import {
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { NodeType } from '@pkg/shared';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Idempotent } from '../shared/idempotency/idempotency.interceptor';
import { GraphService } from './graph.service';

interface AuthedRequest extends Request {
  user: { sub: string };
}

@ApiTags('graph')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('graph')
export class GraphController {
  constructor(private readonly graph: GraphService) {}

  @Get('nodes')
  @ApiOperation({ summary: 'Paginated node list (cursor-based)' })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'type', required: false })
  listNodes(
    @Req() req: AuthedRequest,
    @Query('cursor') cursor?: string,
    @Query('limit') limit = '100',
    @Query('type') type?: string,
  ): Promise<unknown> {
    return this.graph.listNodes(
      req.user.sub,
      cursor,
      Number(limit),
      type as NodeType | undefined,
    );
  }

  @Get('nodes/:id')
  @ApiOperation({ summary: 'Single node detail' })
  async getNode(@Req() req: AuthedRequest, @Param('id') id: string): Promise<unknown> {
    const node = await this.graph.getNode(req.user.sub, id).catch((err: unknown) => {
      if (err instanceof NotFoundException) throw err;
      throw err;
    });
    return node;
  }

  @Get('subgraph')
  subgraph(
    @Req() req: AuthedRequest,
    @Query('rootId') rootId: string,
    @Query('depth') depth = '2',
  ): Promise<unknown> {
    return this.graph.subgraph(req.user.sub, rootId, Number(depth));
  }

  @Get('search')
  @ApiOperation({ summary: 'Full-text node search (Meilisearch-backed)' })
  @ApiQuery({ name: 'q', required: true })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  search(
    @Req() req: AuthedRequest,
    @Query('q') q: string,
    @Query('limit') limit = '20',
  ): Promise<unknown> {
    return this.graph.searchNodes(req.user.sub, q, Number(limit));
  }

  @Get('similar/:nodeId')
  @ApiOperation({
    summary: 'Smart Connections — find semantically similar nodes',
    description:
      'Returns the top-N most similar nodes to the given node, ranked by ' +
      'cosine similarity on stored embedding vectors (fallback: label-token Jaccard). ' +
      'Use this to automatically surface related notes, documents, or concepts.',
  })
  @ApiQuery({
    name: 'topN',
    required: false,
    description: 'Maximum number of similar nodes to return (1–50, default 10)',
    type: Number,
  })
  findSimilar(
    @Req() req: AuthedRequest,
    @Param('nodeId') nodeId: string,
    @Query('topN') topN = '10',
  ): Promise<unknown> {
    return this.graph.findSimilar(req.user.sub, nodeId, Number(topN));
  }

  @Delete('nodes/:id')
  @HttpCode(204)
  @Idempotent()
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'Optional client token; repeating the same key returns the cached response.',
  })
  async deleteNode(@Req() req: AuthedRequest, @Param('id') id: string): Promise<void> {
    await this.graph.deleteNode(req.user.sub, id);
  }
}
