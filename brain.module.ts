import { Module } from '@nestjs/common';
import { GraphModule } from '../graph/graph.module.js';
import { BrainController } from './brain.controller.js';
import { BrainGateway } from './brain.gateway.js';
import { BrainService } from './brain.service.js';
import { ConnectomeLoader } from './connectome-loader.js';

@Module({
  imports: [GraphModule],
  controllers: [BrainController],
  providers: [BrainService, BrainGateway, ConnectomeLoader],
  exports: [BrainService, BrainGateway],
})
export class BrainModule {}
