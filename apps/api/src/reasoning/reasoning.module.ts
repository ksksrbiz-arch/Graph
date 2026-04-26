import { Module } from '@nestjs/common';
import { ReasoningController } from './reasoning.controller';
import { ReasoningRepository } from './reasoning.repository';
import { ReasoningService } from './reasoning.service';

@Module({
  controllers: [ReasoningController],
  providers: [ReasoningService, ReasoningRepository],
  exports: [ReasoningService],
})
export class ReasoningModule {}
