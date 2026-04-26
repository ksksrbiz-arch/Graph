import { Module } from '@nestjs/common';
import { GraphController } from './graph.controller';
import { GraphRepository } from './graph.repository';
import { GraphService } from './graph.service';

@Module({
  controllers: [GraphController],
  providers: [GraphService, GraphRepository],
  exports: [GraphService, GraphRepository],
})
export class GraphModule {}
