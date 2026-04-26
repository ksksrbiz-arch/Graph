import { Controller, Get, Inject } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  HealthIndicatorResult,
} from '@nestjs/terminus';
import type { Pool } from 'pg';
import type Redis from 'ioredis';
import type { Driver } from 'neo4j-driver';
import { loadEnv } from '../config/env';
import { NEO4J_DRIVER } from '../shared/neo4j/neo4j.module';
import { POSTGRES_POOL } from '../shared/postgres/postgres.module';
import { REDIS_CLIENT } from '../shared/redis/redis.module';

@Controller('health')
export class HealthController {
  private readonly env = loadEnv();

  constructor(
    private readonly health: HealthCheckService,
    @Inject(NEO4J_DRIVER) private readonly neo4j: Driver,
    @Inject(POSTGRES_POOL) private readonly postgres: Pool,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
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
      async (): Promise<HealthIndicatorResult> => {
        try {
          await this.postgres.query('SELECT 1');
          return { postgres: { status: 'up' } };
        } catch (err) {
          return {
            postgres: { status: 'down', message: (err as Error).message },
          };
        }
      },
      async (): Promise<HealthIndicatorResult> => {
        try {
          await this.redis.ping();
          return { redis: { status: 'up' } };
        } catch (err) {
          return {
            redis: { status: 'down', message: (err as Error).message },
          };
        }
      },
      async (): Promise<HealthIndicatorResult> => {
        try {
          const response = await fetch(new URL('/health', this.env.MEILI_HOST));
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return { meilisearch: { status: 'up' } };
        } catch (err) {
          const message =
            err instanceof TypeError
              ? `network failure reaching ${this.env.MEILI_HOST}: ${err.message}`
              : (err as Error).message;
          return {
            meilisearch: { status: 'down', message },
          };
        }
      },
    ]);
  }
}
