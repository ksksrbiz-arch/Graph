// Unit tests for AuthService — mocks out UsersService and JwtService so no
// database or crypto is needed. Covers register, login, refresh, and logout.

import { ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { resetEnvCache } from '../config/env';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';

function makeEnv() {
  process.env.JWT_SECRET = 'a'.repeat(32);
  process.env.JWT_ACCESS_TTL_SECONDS = '900';
  process.env.JWT_REFRESH_TTL_SECONDS = '2592000';
  process.env.POSTGRES_URL = 'postgres://u:p@localhost:5432/db';
  process.env.NEO4J_URI = 'bolt://localhost:7687';
  process.env.NEO4J_USER = 'neo4j';
  process.env.NEO4J_PASSWORD = 'neo4j';
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.MEILI_HOST = 'http://localhost:7700';
  process.env.MEILI_MASTER_KEY = 'm';
  process.env.KEK_BASE64 = Buffer.alloc(32, 1).toString('base64');
  resetEnvCache();
}

const mockProfile = {
  id: 'user-1',
  email: 'alice@example.com',
  locale: 'en',
  createdAt: new Date().toISOString(),
};

const mockRow = {
  id: 'user-1',
  email: 'alice@example.com',
  // bcrypt hash of 'secret' — pre-computed so tests run without real bcrypt
  password_hash: '$2b$12$9vFwqFQa.s1K2NmNjV7.m.hZt9Xx.BF/0mSJRzaqQYIDaFN.jBStm',
  display_name: null,
  locale: 'en',
  created_at: new Date(),
  updated_at: new Date(),
  deleted_at: null,
};

async function makeService() {
  makeEnv();
  const mockUsers: jest.Mocked<Partial<UsersService>> = {
    create: jest.fn().mockResolvedValue(mockProfile),
    findRowByEmail: jest.fn().mockResolvedValue(mockRow),
    findById: jest.fn().mockResolvedValue(mockProfile),
    createRefreshToken: jest.fn().mockResolvedValue(undefined),
    findRefreshToken: jest.fn().mockResolvedValue({
      id: 'rt-1',
      user_id: 'user-1',
      token_hash: 'hash',
      expires_at: new Date(Date.now() + 86_400_000),
      revoked_at: null,
      created_at: new Date(),
    }),
    revokeRefreshToken: jest.fn().mockResolvedValue(undefined),
  };

  const mod = await Test.createTestingModule({
    providers: [
      AuthService,
      {
        provide: JwtService,
        useValue: { signAsync: jest.fn().mockResolvedValue('access-token') },
      },
      { provide: UsersService, useValue: mockUsers },
    ],
  }).compile();

  return {
    service: mod.get(AuthService),
    users: mod.get<jest.Mocked<UsersService>>(UsersService),
    jwt: mod.get<jest.Mocked<JwtService>>(JwtService),
  };
}

describe('AuthService.register', () => {
  it('creates a user and returns a token pair', async () => {
    const { service, users } = await makeService();
    const result = await service.register('alice@example.com', 'secret');
    expect(users.create).toHaveBeenCalledWith(
      'alice@example.com',
      expect.stringMatching(/^\$2b\$/), // bcrypt hash
      undefined,
    );
    expect(result.accessToken).toBe('access-token');
    expect(typeof result.refreshToken).toBe('string');
    expect(result.refreshToken.length).toBeGreaterThan(20);
  });

  it('propagates ConflictException when email is taken', async () => {
    const { service, users } = await makeService();
    (users.create as jest.Mock).mockRejectedValueOnce(
      new ConflictException('email already registered'),
    );
    await expect(service.register('alice@example.com', 'pw')).rejects.toThrow(
      ConflictException,
    );
  });
});

describe('AuthService.login', () => {
  it('returns a token pair for valid credentials', async () => {
    const { service, users } = await makeService();
    // Use a real bcrypt hash for 'secret' to validate the compare path
    const bcrypt = await import('bcrypt');
    const hash = await bcrypt.hash('secret', 1);
    (users.findRowByEmail as jest.Mock).mockResolvedValueOnce({
      ...mockRow,
      password_hash: hash,
    });
    const result = await service.login('alice@example.com', 'secret');
    expect(result.accessToken).toBe('access-token');
  });

  it('throws 401 when email is not found', async () => {
    const { service, users } = await makeService();
    (users.findRowByEmail as jest.Mock).mockResolvedValueOnce(null);
    await expect(
      service.login('nobody@example.com', 'pw'),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('throws 401 when password is wrong', async () => {
    const { service } = await makeService();
    await expect(
      service.login('alice@example.com', 'wrong-password'),
    ).rejects.toThrow(UnauthorizedException);
  });
});

describe('AuthService.refresh', () => {
  it('revokes old token and issues a new pair', async () => {
    const { service, users } = await makeService();
    const result = await service.refresh('raw-token');
    expect(users.revokeRefreshToken).toHaveBeenCalled();
    expect(result.accessToken).toBe('access-token');
    expect(typeof result.refreshToken).toBe('string');
  });

  it('throws 401 when token is revoked', async () => {
    const { service, users } = await makeService();
    (users.findRefreshToken as jest.Mock).mockResolvedValueOnce({
      id: 'rt-1',
      user_id: 'user-1',
      token_hash: 'hash',
      expires_at: new Date(Date.now() + 86_400_000),
      revoked_at: new Date(), // already revoked
      created_at: new Date(),
    });
    await expect(service.refresh('raw-token')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('throws 401 when token is expired', async () => {
    const { service, users } = await makeService();
    (users.findRefreshToken as jest.Mock).mockResolvedValueOnce({
      id: 'rt-1',
      user_id: 'user-1',
      token_hash: 'hash',
      expires_at: new Date(Date.now() - 1_000), // expired
      revoked_at: null,
      created_at: new Date(),
    });
    await expect(service.refresh('raw-token')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('throws 401 when token is not found', async () => {
    const { service, users } = await makeService();
    (users.findRefreshToken as jest.Mock).mockResolvedValueOnce(null);
    await expect(service.refresh('unknown-token')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('throws 404 when user was deleted between token issuance and refresh', async () => {
    const { service, users } = await makeService();
    (users.findById as jest.Mock).mockRejectedValueOnce(
      new NotFoundException('user not found'),
    );
    await expect(service.refresh('raw-token')).rejects.toThrow(NotFoundException);
  });
});

describe('AuthService.logout', () => {
  it('revokes the refresh token', async () => {
    const { service, users } = await makeService();
    await service.logout('raw-token');
    expect(users.revokeRefreshToken).toHaveBeenCalledWith(
      expect.any(String),
    );
  });
});
