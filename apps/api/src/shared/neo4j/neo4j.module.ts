import { Global, Module } from '@nestjs/common';
import neo4j, { type Driver } from 'neo4j-driver';
import { loadEnv } from '../../config/env';

export const NEO4J_DRIVER = Symbol('NEO4J_DRIVER');

@Global()
@Module({
  providers: [
    {
      provide: NEO4J_DRIVER,
      useFactory: (): Driver => {
        const env = loadEnv();
        return neo4j.driver(
          env.NEO4J_URI,
          neo4j.auth.basic(env.NEO4J_USER, env.NEO4J_PASSWORD),
          { disableLosslessIntegers: true },
        );
      },
    },
  ],
  exports: [NEO4J_DRIVER],
})
export class Neo4jModule {}
