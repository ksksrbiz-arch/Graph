import { Module } from '@nestjs/common';
import { AttentionService } from './attention.service';
import { BrainController } from './brain.controller';
import { BrainGateway } from './brain.gateway';
import { BrainService } from './brain.service';
import { ConnectomeLoader } from './connectome.loader';
import { DreamService } from './dream.service';
import { RecallService } from './recall.service';
import { SensoryService } from './sensory.service';

@Module({
  controllers: [BrainController],
  providers: [
    BrainService,
    BrainGateway,
    ConnectomeLoader,
    SensoryService,
    AttentionService,
    DreamService,
    RecallService,
  ],
  exports: [
    BrainService,
    SensoryService,
    AttentionService,
    DreamService,
    RecallService,
  ],
})
export class BrainModule {}
