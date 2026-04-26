import { Module } from '@nestjs/common';
import { BrainController } from './brain.controller';
import { BrainGateway } from './brain.gateway';
import { BrainService } from './brain.service';
import { ConnectomeLoader } from './connectome.loader';

@Module({
  controllers: [BrainController],
  providers: [BrainService, BrainGateway, ConnectomeLoader],
  exports: [BrainService],
})
export class BrainModule {}
