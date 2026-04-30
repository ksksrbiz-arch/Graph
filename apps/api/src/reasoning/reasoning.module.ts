import { Module } from '@nestjs/common';
import { ReasoningController } from './reasoning.controller';
import { ReasoningRepository } from './reasoning.repository';
import { ReasoningService } from './reasoning.service';

@Module({
  controllers: [ReasoningController],
  providers: [ReasoningService, ReasoningRepository],
  // Export ReasoningRepository so BrainModule's CortexService can load the
  // user graph snapshot directly without re-implementing the Cypher loader.
  exports: [ReasoningService, ReasoningRepository],
})
export class ReasoningModule {}
