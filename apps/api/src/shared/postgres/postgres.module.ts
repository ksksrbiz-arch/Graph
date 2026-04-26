import { Global, Inject, Module, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import { loadEnv } from '../../config/env';

export const POSTGRES_POOL = Symbol('POSTGRES_POOL');

@Global()
@Module({
  providers: [
    {
      provide: POSTGRES_POOL,
      useFactory: (): Pool =>
        new Pool({
          connectionString: loadEnv().POSTGRES_URL,
          max: 5,
        }),
    },
  ],
  exports: [POSTGRES_POOL],
})
export class PostgresModule implements OnModuleDestroy {
  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
