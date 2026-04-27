import { Module } from '@nestjs/common';
import { GraphController } from './graph.controller';
import { GraphRepository } from './graph.repository';
import { GraphService } from './graph.service';
import { SmartConnectionsService } from './smart-connections.service';

@Module({
  controllers: [GraphController],
  providers: [GraphService, GraphRepository, SmartConnectionsService],
  exports: [GraphService, GraphRepository],
})
export class GraphModule {}
