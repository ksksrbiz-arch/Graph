// BullMQ-backed sync orchestrator (spec §8.1, §13.3).
// Phase 0 leaves the module empty — Phase 4 onward wires queues per connector.

import { Module } from '@nestjs/common';

@Module({})
export class SyncModule {}
