// Unit tests for AuditService — verifies that record() hits the expected
// Postgres INSERT and that errors are swallowed (never crashing the caller).

import { Test } from '@nestjs/testing';
import { POSTGRES_POOL } from '../shared/postgres/postgres.module';
import { AuditService } from './audit.service';

async function makeService(pool = { query: jest.fn().mockResolvedValue({ rows: [] }) }) {
  const mod = await Test.createTestingModule({
    providers: [
      AuditService,
      { provide: POSTGRES_POOL, useValue: pool },
    ],
  }).compile();
  return { service: mod.get(AuditService), pool };
}

describe('AuditService.record', () => {
  it('inserts an audit event with all fields', async () => {
    const { service, pool } = await makeService();
    await service.record({
      userId: 'user-1',
      action: 'PATCH /users/me',
      resource: 'UsersController',
      resourceId: 'user-1',
      metadata: { statusCode: 200 },
      ipAddress: '127.0.0.1',
    });
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO audit_events'),
      ['user-1', 'PATCH /users/me', 'UsersController', 'user-1', expect.any(String), '127.0.0.1'],
    );
  });

  it('works when optional fields are omitted', async () => {
    const { service, pool } = await makeService();
    await service.record({ action: 'DELETE /users/me' });
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO audit_events'),
      [null, 'DELETE /users/me', null, null, null, null],
    );
  });

  it('swallows database errors and does not throw', async () => {
    const pool = { query: jest.fn().mockRejectedValueOnce(new Error('pg down')) };
    const { service } = await makeService(pool);
    // Should not throw even when the INSERT fails
    await expect(service.record({ action: 'test' })).resolves.toBeUndefined();
  });
});
