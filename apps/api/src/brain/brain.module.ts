import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ServiceAuthGuard } from '../auth/guards/service-auth.guard';
import { ReasoningModule } from '../reasoning/reasoning.module';
import { AttentionService } from './attention.service';
import { BrainController } from './brain.controller';
import { BrainGateway } from './brain.gateway';
import { BrainRuntimeService } from './brain-runtime.service';
import { BrainService } from './brain.service';
import { CerebralStreamController } from './cerebral-stream.controller';
import { CerebralStreamService } from './cerebral-stream.service';
import { ConnectomeLoader } from './connectome.loader';
import { CortexController } from './cortex.controller';
import { CortexService } from './cortex.service';
import { DreamService } from './dream.service';
import { InsightsController } from './insights.controller';
import { InternalBrainController } from './internal-brain.controller';
import { InsightsService } from './insights.service';
import { RecallService } from './recall.service';
import { SensoryService } from './sensory.service';

@Module({
  imports: [AuthModule, ReasoningModule],
  controllers: [
    BrainController,
    InsightsController,
    CortexController,
    CerebralStreamController,
    InternalBrainController,
  ],
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
    CerebralStreamService,
    ServiceAuthGuard,
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
    CerebralStreamService,
  ],
})
export class BrainModule {}
