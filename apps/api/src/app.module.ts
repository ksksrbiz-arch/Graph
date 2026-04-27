import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { BrainModule } from './brain/brain.module';
import { ConnectorConfigsModule } from './connectors/connector-configs.module';
import { ConnectorsModule } from './connectors/connectors.module';
import { GraphModule } from './graph/graph.module';
import { HealthModule } from './health/health.module';
import { MotorModule } from './motor/motor.module';
import { OAuthModule } from './oauth/oauth.module';
import { PublicModule } from './public/public.module';
import { ReasoningModule } from './reasoning/reasoning.module';
import { Neo4jModule } from './shared/neo4j/neo4j.module';
import { CryptoModule } from './shared/crypto/crypto.module';
import { IdempotencyModule } from './shared/idempotency/idempotency.module';
import { SyncModule } from './sync/sync.module';
import { UsersModule } from './users/users.module';
import { PostgresModule } from './shared/postgres/postgres.module';
import { RedisModule } from './shared/redis/redis.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Spec §10.1: 100 req/min/user.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    CryptoModule,
    IdempotencyModule,
    Neo4jModule,
    PostgresModule,
    RedisModule,
    HealthModule,
    AuthModule,
    UsersModule,
    AuditModule,
    GraphModule,
    BrainModule,
    MotorModule,
    ReasoningModule,
    ConnectorConfigsModule,
    OAuthModule,
    ConnectorsModule,
    SyncModule,
    PublicModule,
  ],
})
export class AppModule {}
