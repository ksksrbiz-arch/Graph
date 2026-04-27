// User management backed by the `users` and `refresh_tokens` Postgres tables
// (infra/postgres/init/001-schema.sql). Implements profile CRUD and the
// refresh-token store required by AuthService (spec §9.1, Rule 18).

import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Pool } from 'pg';
import type { UserProfile } from '@pkg/shared';
import { POSTGRES_POOL } from '../shared/postgres/postgres.module';

export interface UserRow {
  id: string;
  email: string;
  password_hash: string | null;
  display_name: string | null;
  locale: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface RefreshTokenRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
  created_at: Date;
}

const PG_UNIQUE_VIOLATION = '23505';

@Injectable()
export class UsersService {
  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  async create(
    email: string,
    passwordHash: string | null,
    displayName?: string,
  ): Promise<UserProfile> {
    try {
      const result = await this.pool.query<UserRow>(
        `INSERT INTO users (email, password_hash, display_name)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [this.normalizeEmail(email), passwordHash, displayName ?? null],
      );
      return this.toProfile(result.rows[0]);
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        'code' in err &&
        (err as NodeJS.ErrnoException).code === PG_UNIQUE_VIOLATION
      ) {
        throw new ConflictException(`email already registered: ${email}`);
      }
      throw err;
    }
  }

  async findById(id: string): Promise<UserProfile> {
    const result = await this.pool.query<UserRow>(
      `SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    if (!result.rows[0]) throw new NotFoundException(`user not found: ${id}`);
    return this.toProfile(result.rows[0]);
  }

  /** Returns full row including password_hash — only for auth use. */
  async findRowByEmail(email: string): Promise<UserRow | null> {
    const result = await this.pool.query<UserRow>(
      `SELECT * FROM users WHERE email = $1 AND deleted_at IS NULL`,
      [this.normalizeEmail(email)],
    );
    return result.rows[0] ?? null;
  }

  async updateProfile(
    id: string,
    update: { displayName?: string; locale?: string },
  ): Promise<UserProfile> {
    const result = await this.pool.query<UserRow>(
      `UPDATE users
       SET display_name = COALESCE($2, display_name),
           locale       = COALESCE($3, locale),
           updated_at   = now()
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING *`,
      [id, update.displayName ?? null, update.locale ?? null],
    );
    if (!result.rows[0]) throw new NotFoundException(`user not found: ${id}`);
    return this.toProfile(result.rows[0]);
  }

  /** Soft-delete: sets deleted_at. Hard data is purged later by GDPR jobs. */
  async softDelete(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE users SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
  }

  // ── refresh tokens ──

  async createRefreshToken(
    userId: string,
    tokenHash: string,
    expiresAt: Date,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
      [userId, tokenHash, expiresAt],
    );
  }

  async findRefreshToken(tokenHash: string): Promise<RefreshTokenRow | null> {
    const result = await this.pool.query<RefreshTokenRow>(
      `SELECT * FROM refresh_tokens WHERE token_hash = $1`,
      [tokenHash],
    );
    return result.rows[0] ?? null;
  }

  async revokeRefreshToken(tokenHash: string): Promise<void> {
    await this.pool.query(
      `UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1`,
      [tokenHash],
    );
  }

  /** Purge all refresh tokens for a user (used on account delete). */
  async revokeAllForUser(userId: string): Promise<void> {
    await this.pool.query(
      `UPDATE refresh_tokens SET revoked_at = now()
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
  }

  // ── helpers ──

  private normalizeEmail(email: string): string {
    return email.toLowerCase().trim();
  }

  private toProfile(row: UserRow): UserProfile {
    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name ?? undefined,
      locale: row.locale,
      createdAt: row.created_at.toISOString(),
    };
  }
}
