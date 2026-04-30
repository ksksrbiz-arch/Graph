// Autonomous cortex agent. Composes:
//   • the deterministic cortex pipeline (BrainModule.CortexService)
//   • the connector + sync pipeline (SyncModule.SyncOrchestrator)
//   • the reasoning service (ReasoningModule.ReasoningService)
//   • a per-user permission store (this module)
//
// Every motor action goes through a permission check + audit record before
// it touches the brain or the data plane.

import { Module, OnModuleInit } from '@nestjs/common';
import { BrainModule } from '../brain/brain.module';
import { CerebralStreamService } from '../brain/cerebral-stream.service';
import { ReasoningModule } from '../reasoning/reasoning.module';
import { SyncModule } from '../sync/sync.module';
import { AgentController } from './agent.controller';
import { AgentPermissionStore } from './agent-permission.store';
import { AgentService } from './agent.service';

// ConnectorConfigsModule + AuditModule are both @Global() so they are
// resolved transitively without an explicit import.
@Module({
  imports: [BrainModule, ReasoningModule, SyncModule],
  controllers: [AgentController],
  providers: [AgentService, AgentPermissionStore],
  exports: [AgentService, AgentPermissionStore],
})
export class AgentModule implements OnModuleInit {
  constructor(
    private readonly cerebralStream: CerebralStreamService,
    private readonly agent: AgentService,
    private readonly permissions: AgentPermissionStore,
  ) {}

  /** Install the agent bridge after BrainModule has booted so the cerebral
   *  stream can drive permission-gated agent cycles on every autonomous
   *  thought. */
  onModuleInit(): void {
    this.cerebralStream.setAgentBridge({
      hasPermission: (userId, scope) =>
        this.permissions.has(userId, scope as Parameters<typeof this.permissions.has>[1]),
      run: (userId, opts) => this.agent.run(userId, opts),
    });
  }
}
