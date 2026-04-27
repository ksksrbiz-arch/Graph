import { Module } from '@nestjs/common';
import { BrainModule } from '../brain/brain.module';
import { GraphModule } from '../graph/graph.module';
import { PublicController } from './public.controller';
import { PublicIngestService } from './public-ingest.service';

@Module({
  imports: [GraphModule, BrainModule],
  controllers: [PublicController],
  providers: [PublicIngestService],
  exports: [PublicIngestService],
})
export class PublicModule {}
