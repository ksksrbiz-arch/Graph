// REST endpoints for graph access — spec §6.1 rows under /graph/*.
// All routes are guarded by JwtAuthGuard. Pagination is cursor-based (Rule 17).

import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
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

  @Get('subgraph')
  subgraph(
    @Req() req: AuthedRequest,
    @Query('rootId') rootId: string,
    @Query('depth') depth = '2',
  ): Promise<unknown> {
    return this.graph.subgraph(req.user.sub, rootId, Number(depth));
  }

  @Delete('nodes/:id')
  @HttpCode(204)
  async deleteNode(@Req() req: AuthedRequest, @Param('id') id: string): Promise<void> {
    await this.graph.deleteNode(req.user.sub, id);
  }
}
