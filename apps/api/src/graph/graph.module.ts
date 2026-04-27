import { Module } from '@nestjs/common';
import { MeilisearchModule } from '../shared/meilisearch/meilisearch.module';
import { GraphController } from './graph.controller';
import { GraphGateway } from './graph.gateway';
import { GraphRepository } from './graph.repository';
import { GraphResolver } from './graph.resolver';
import { GraphService } from './graph.service';
import { SmartConnectionsService } from './smart-connections.service';

@Module({
  imports: [MeilisearchModule],
  controllers: [GraphController],
  providers: [GraphService, GraphRepository, SmartConnectionsService, GraphGateway, GraphResolver],
  exports: [GraphService, GraphRepository],
})
export class GraphModule {}
