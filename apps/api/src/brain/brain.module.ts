import { Module } from '@nestjs/common';
import { ReasoningModule } from '../reasoning/reasoning.module';
import { AttentionService } from './attention.service';
import { BrainController } from './brain.controller';
import { BrainGateway } from './brain.gateway';
import { BrainRuntimeService } from './brain-runtime.service';
import { BrainService } from './brain.service';
import { ConnectomeLoader } from './connectome.loader';
import { CortexController } from './cortex.controller';
import { CortexService } from './cortex.service';
import { DreamService } from './dream.service';
import { InsightsController } from './insights.controller';
import { InsightsService } from './insights.service';
import { RecallService } from './recall.service';
import { SensoryService } from './sensory.service';

@Module({
  imports: [ReasoningModule],
  controllers: [BrainController, InsightsController, CortexController],
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
    CortexService,
  ],
  exports: [
    BrainService,
    BrainRuntimeService,
    SensoryService,
    AttentionService,
    DreamService,
    RecallService,
    InsightsService,
    CortexService,
  ],
})
export class BrainModule {}
