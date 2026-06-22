// Unit tests for UsersService — all Postgres calls are mocked via a fake Pool.

import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { POSTGRES_POOL } from '../shared/postgres/postgres.module';
import { UsersService } from './users.service';

function mockPool(rows: Record<string, unknown>[] = [], rowCount = rows.length) {
  return { query: jest.fn().mockResolvedValue({ rows, rowCount }) };
}

async function makeService(pool = mockPool()) {
  const mod = await Test.createTestingModule({
    providers: [
      UsersService,
      { provide: POSTGRES_POOL, useValue: pool },
    ],
  }).compile();
  return { service: mod.get(UsersService), pool };
}

const now = new Date();
const dbRow = {
  id: 'user-1',
  email: 'alice@example.com',
  password_hash: 'hash',
  display_name: 'Alice',
  locale: 'en',
  created_at: now,
  updated_at: now,
  deleted_at: null,
};

describe('UsersService.create', () => {
  it('inserts a user and returns a profile', async () => {
    const pool = mockPool([dbRow]);
    const { service } = await makeService(pool);
    const profile = await service.create('alice@example.com', 'hash', 'Alice');
    expect(profile.id).toBe('user-1');
    expect(profile.email).toBe('alice@example.com');
    expect(profile.displayName).toBe('Alice');
  });

  it('throws ConflictException on duplicate email (pg error 23505)', async () => {
    const pool = mockPool();
    const err = Object.assign(new Error('dup'), { code: '23505' });
    (pool.query as jest.Mock).mockRejectedValueOnce(err);
    const { service } = await makeService(pool);
    await expect(service.create('alice@example.com', 'hash')).rejects.toThrow(
      ConflictException,
    );
  });
});

describe('UsersService.findById', () => {
  it('returns a profile for a known user', async () => {
    const { service } = await makeService(mockPool([dbRow]));
    const profile = await service.findById('user-1');
    expect(profile.email).toBe('alice@example.com');
  });

  it('throws NotFoundException when user does not exist', async () => {
    const { service } = await makeService(mockPool([]));
    await expect(service.findById('no-such')).rejects.toThrow(NotFoundException);
  });
});

describe('UsersService.findRowByEmail', () => {
  it('returns the full row (including password_hash)', async () => {
    const { service } = await makeService(mockPool([dbRow]));
    const row = await service.findRowByEmail('alice@example.com');
    expect(row?.password_hash).toBe('hash');
  });

  it('returns null for unknown email', async () => {
    const { service } = await makeService(mockPool([]));
    const row = await service.findRowByEmail('ghost@example.com');
    expect(row).toBeNull();
  });
});

describe('UsersService.updateProfile', () => {
  it('returns updated profile', async () => {
    const updated = { ...dbRow, display_name: 'Bob', locale: 'fr' };
    const { service } = await makeService(mockPool([updated]));
    const profile = await service.updateProfile('user-1', {
      displayName: 'Bob',
      locale: 'fr',
    });
    expect(profile.displayName).toBe('Bob');
    expect(profile.locale).toBe('fr');
  });

  it('throws NotFoundException when user does not exist', async () => {
    const { service } = await makeService(mockPool([]));
    await expect(
      service.updateProfile('ghost', { displayName: 'X' }),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('UsersService.softDelete', () => {
  it('issues an UPDATE query', async () => {
    const { service, pool } = await makeService(mockPool([]));
    await service.softDelete('user-1');
    expect(pool.query).toHaveBeenCalledWith(expect.any(String), ['user-1']);
  });
});

describe('UsersService.hardDelete', () => {
  it('issues a single DELETE and resolves when the user exists', async () => {
    const pool = mockPool([], 1);
    const { service } = await makeService(pool);
    await expect(service.hardDelete('user-1')).resolves.toBeUndefined();
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM users'),
      ['user-1'],
    );
    // Only one query — FK CASCADE handles refresh_tokens
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('throws NotFoundException when rowCount is 0 (user not found)', async () => {
    const pool = mockPool([], 0);
    const { service } = await makeService(pool);
    await expect(service.hardDelete('ghost')).rejects.toThrow(NotFoundException);
  });
});

describe('UsersService.exportData', () => {
  const tokenRow = {
    id: 'tok-1',
    user_id: 'user-1',
    token_hash: 'h',
    expires_at: new Date('2030-01-01'),
    revoked_at: null,
    created_at: new Date('2024-01-01'),
  };

  it('returns profile and refresh tokens for a known user', async () => {
    const pool = { query: jest.fn() };
    pool.query
      .mockResolvedValueOnce({ rows: [dbRow], rowCount: 1 })   // users query
      .mockResolvedValueOnce({ rows: [tokenRow], rowCount: 1 }); // refresh_tokens query
    const { service } = await makeService(pool as ReturnType<typeof mockPool>);
    const data = await service.exportData('user-1');
    expect(data.profile.id).toBe('user-1');
    expect(data.refreshTokens).toHaveLength(1);
    expect(data.refreshTokens[0].id).toBe('tok-1');
    expect(data.refreshTokens[0].expiresAt).toBe('2030-01-01T00:00:00.000Z');
  });

  it('queries users table directly (does not filter deleted_at)', async () => {
    const pool = { query: jest.fn() };
    pool.query
      .mockResolvedValueOnce({ rows: [dbRow], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const { service } = await makeService(pool as ReturnType<typeof mockPool>);
    await service.exportData('user-1');
    const firstCall = (pool.query as jest.Mock).mock.calls[0] as [string, unknown[]];
    expect(firstCall[0]).toContain('SELECT * FROM users WHERE id = $1');
    expect(firstCall[0]).not.toContain('deleted_at');
  });

  it('throws NotFoundException when user not found', async () => {
    const pool = { query: jest.fn() };
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const { service } = await makeService(pool as ReturnType<typeof mockPool>);
    await expect(service.exportData('ghost')).rejects.toThrow(NotFoundException);
  });
});

describe('UsersService refresh-token helpers', () => {
  it('createRefreshToken calls INSERT', async () => {
    const { service, pool } = await makeService(mockPool([]));
    await service.createRefreshToken('user-1', 'hash', new Date());
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO refresh_tokens'),
      expect.any(Array),
    );
  });

  it('findRefreshToken returns null when not found', async () => {
    const { service } = await makeService(mockPool([]));
    expect(await service.findRefreshToken('no-hash')).toBeNull();
  });

  it('revokeRefreshToken calls UPDATE', async () => {
    const { service, pool } = await makeService(mockPool([]));
    await service.revokeRefreshToken('token-hash');
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE refresh_tokens'),
      ['token-hash'],
    );
  });
});
