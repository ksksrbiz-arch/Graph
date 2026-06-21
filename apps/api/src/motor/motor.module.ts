import { Module } from '@nestjs/common';
import { BrainModule } from '../brain/brain.module';
import { ApprovalQueueService } from './approval-queue.service';
import { MotorController } from './motor.controller';
import { SafetySupervisor } from './safety-supervisor';

@Module({
  imports: [BrainModule],
  controllers: [MotorController],
  providers: [SafetySupervisor, ApprovalQueueService],
  exports: [SafetySupervisor, ApprovalQueueService],
})
export class MotorModule {}
