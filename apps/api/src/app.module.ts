import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { ConnectorsModule } from './connectors/connectors.module';
import { GraphModule } from './graph/graph.module';
import { HealthModule } from './health/health.module';
import { Neo4jModule } from './shared/neo4j/neo4j.module';
import { CryptoModule } from './shared/crypto/crypto.module';
import { SyncModule } from './sync/sync.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Spec §10.1: 100 req/min/user.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    CryptoModule,
    Neo4jModule,
    HealthModule,
    AuthModule,
    UsersModule,
    AuditModule,
    GraphModule,
    ConnectorsModule,
    SyncModule,
  ],
})
export class AppModule {}
