// JWT issuance + refresh-token rotation (Phase 1).
// Uses bcrypt for password hashing and SHA-256 to derive the stored token hash
// so the raw token never touches the database (Rule 18, ADR-006).

import {
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'node:crypto';
import * as bcrypt from 'bcrypt';
import { loadEnv } from '../config/env';
import { UsersService } from '../users/users.service';

export interface AccessTokenPayload {
  sub: string;
  email: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

const BCRYPT_ROUNDS = 12;
const REFRESH_TOKEN_BYTES = 48;

@Injectable()
export class AuthService {
  constructor(
    private readonly jwt: JwtService,
    private readonly users: UsersService,
  ) {}

  async signAccessToken(payload: AccessTokenPayload): Promise<string> {
    return this.jwt.signAsync(payload);
  }

  async register(
    email: string,
    password: string,
    displayName?: string,
  ): Promise<TokenPair> {
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const profile = await this.users.create(email, passwordHash, displayName);
    return this.issueTokenPair(profile.id, profile.email);
  }

  async login(email: string, password: string): Promise<TokenPair> {
    const row = await this.users.findRowByEmail(email);
    if (!row || !row.password_hash) {
      throw new UnauthorizedException('invalid credentials');
    }
    const valid = await bcrypt.compare(password, row.password_hash);
    if (!valid) throw new UnauthorizedException('invalid credentials');
    return this.issueTokenPair(row.id, row.email);
  }

  /** Rotate a refresh token: revoke the old one, issue a fresh pair. */
  async refresh(rawRefreshToken: string): Promise<TokenPair> {
    const hash = this.hashToken(rawRefreshToken);
    const row = await this.users.findRefreshToken(hash);
    if (
      !row ||
      row.revoked_at !== null ||
      row.expires_at < new Date()
    ) {
      throw new UnauthorizedException('invalid or expired refresh token');
    }
    await this.users.revokeRefreshToken(hash);

    // Re-fetch user to ensure they still exist (not soft-deleted).
    const profile = await this.users.findById(row.user_id);
    return this.issueTokenPair(profile.id, profile.email);
  }

  /** Revoke a refresh token (logout). */
  async logout(rawRefreshToken: string): Promise<void> {
    const hash = this.hashToken(rawRefreshToken);
    await this.users.revokeRefreshToken(hash);
  }

  // ── internals ──

  private async issueTokenPair(
    userId: string,
    email: string,
  ): Promise<TokenPair> {
    const accessToken = await this.jwt.signAsync({ sub: userId, email });

    const raw = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
    const hash = this.hashToken(raw);
    const env = loadEnv();
    const expiresAt = new Date(
      Date.now() + env.JWT_REFRESH_TTL_SECONDS * 1000,
    );
    await this.users.createRefreshToken(userId, hash, expiresAt);

    return { accessToken, refreshToken: raw };
  }

  private hashToken(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }
}

