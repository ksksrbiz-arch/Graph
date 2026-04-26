import { Module } from '@nestjs/common';
import { BrainModule } from '../brain/brain.module';
import { MotorController } from './motor.controller';
import { SafetySupervisor } from './safety-supervisor';

@Module({
  imports: [BrainModule],
  controllers: [MotorController],
  providers: [SafetySupervisor],
  exports: [SafetySupervisor],
})
export class MotorModule {}
