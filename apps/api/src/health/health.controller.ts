import { Controller, Get, Inject } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  HealthIndicatorResult,
} from '@nestjs/terminus';
import type { Driver } from 'neo4j-driver';
import { NEO4J_DRIVER } from '../shared/neo4j/neo4j.module';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    @Inject(NEO4J_DRIVER) private readonly neo4j: Driver,
  ) {}

  /** Liveness — just confirms the process is up. Spec §13.4. */
  @Get()
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness — verifies downstream connectivity. Spec §13.4. */
  @Get('ready')
  @HealthCheck()
  ready(): Promise<unknown> {
    return this.health.check([
      async (): Promise<HealthIndicatorResult> => {
        const session = this.neo4j.session();
        try {
          await session.run('RETURN 1 AS ok');
          return { neo4j: { status: 'up' } };
        } catch (err) {
          return {
            neo4j: { status: 'down', message: (err as Error).message },
          };
        } finally {
          await session.close();
        }
      },
    ]);
  }
}
