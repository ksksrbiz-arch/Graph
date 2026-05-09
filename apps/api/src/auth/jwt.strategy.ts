import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { loadEnv } from '../config/env';
import type { AccessTokenPayload } from './auth.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: loadEnv().JWT_SECRET,
      audience: 'graph-worker',
      issuer: 'graph-api',
    });
  }

  validate(payload: AccessTokenPayload): AccessTokenPayload {
    return {
      ...payload,
      tenantId: payload.tenantId || payload.sub,
      roles: Array.isArray(payload.roles) ? payload.roles : [],
    };
  }
}
