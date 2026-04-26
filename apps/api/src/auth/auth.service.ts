// Phase 1 work — JWT issuance + refresh-token rotation. Phase 0 ships only the
// signing skeleton so the rest of the API can declare guarded routes against
// a stable interface.

import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

export interface AccessTokenPayload {
  sub: string;
  email: string;
}

@Injectable()
export class AuthService {
  constructor(private readonly jwt: JwtService) {}

  async signAccessToken(payload: AccessTokenPayload): Promise<string> {
    return this.jwt.signAsync(payload);
  }

  async login(email: string, _password: string): Promise<{ accessToken: string }> {
    // TODO(phase-1): replace with real user lookup + bcrypt.compare.
    // Returning a 401 is intentional — until Phase 1 lands, login is disabled.
    throw new UnauthorizedException('login is implemented in Phase 1');
  }
}
