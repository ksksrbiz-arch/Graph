import { Module } from '@nestjs/common';
import { GraphModule } from '../graph/graph.module';
import { ArcController } from './arc.controller';
import { ArcService } from './arc.service';

@Module({
  imports: [GraphModule],
  controllers: [ArcController],
  providers: [ArcService],
  exports: [ArcService],
})
export class ArcModule {}
