// Audit log writer — every mutation flows through here (spec §10.4, Rule 18).
// Backed by the append-only `audit_events` Postgres table.

import { Module } from '@nestjs/common';

@Module({})
export class AuditModule {}
