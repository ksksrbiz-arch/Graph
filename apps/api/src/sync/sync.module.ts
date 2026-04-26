// Auto-updating data flow plumbing. SyncOrchestrator runs jobs (manual +
// scheduled) and reports progress via SyncGateway. SyncScheduler reads enabled
// ConnectorConfigs and ticks each one at its configured interval.
//
// ADR-005 (BullMQ) is the production target — see sync.orchestrator.ts and
// sync.scheduler.ts for the swap surface.

import { Module, forwardRef } from '@nestjs/common';
import { BrainModule } from '../brain/brain.module';
import { ConnectorsModule } from '../connectors/connectors.module';
import { GraphModule } from '../graph/graph.module';
import { SyncGateway } from './sync.gateway';
import { SyncOrchestrator } from './sync.orchestrator';
import { SyncScheduler } from './sync.scheduler';

@Module({
  imports: [forwardRef(() => ConnectorsModule), GraphModule, BrainModule],
  providers: [SyncOrchestrator, SyncScheduler, SyncGateway],
  exports: [SyncOrchestrator],
})
export class SyncModule {}
