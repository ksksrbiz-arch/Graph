import { Module } from '@nestjs/common';
import { AttentionService } from './attention.service';
import { BrainController } from './brain.controller';
import { BrainGateway } from './brain.gateway';
import { BrainRuntimeService } from './brain-runtime.service';
import { BrainService } from './brain.service';
import { ConnectomeLoader } from './connectome.loader';
import { DreamService } from './dream.service';
import { InsightsController } from './insights.controller';
import { InsightsService } from './insights.service';
import { RecallService } from './recall.service';
import { SensoryService } from './sensory.service';

@Module({
  controllers: [BrainController, InsightsController],
  providers: [
    BrainService,
    BrainRuntimeService,
    BrainGateway,
    ConnectomeLoader,
    SensoryService,
    AttentionService,
    DreamService,
    RecallService,
    InsightsService,
  ],
  exports: [
    BrainService,
    BrainRuntimeService,
    SensoryService,
    AttentionService,
    DreamService,
    RecallService,
    InsightsService,
  ],
})
export class BrainModule {}
