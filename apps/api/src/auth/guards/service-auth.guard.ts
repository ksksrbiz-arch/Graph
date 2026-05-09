import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { loadEnv } from '../../config/env';

export interface ServiceAuthClaims {
  sub: string;
  tenantId: string;
  roles: string[];
  aud: string;
  iss: string;
}

export interface ServiceAuthedRequest extends Request {
  serviceAuth: ServiceAuthClaims;
}

const SERVICE_ISSUER = 'graph-worker';
const SERVICE_AUDIENCE = 'graph-api-brain';

@Injectable()
export class ServiceAuthGuard implements CanActivate {
  private readonly env = loadEnv();

  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ServiceAuthedRequest>();
    const token = this.extractBearer(request);
    if (!token) throw new UnauthorizedException('missing service bearer token');

    const payload = await this.jwt.verifyAsync<ServiceAuthClaims>(token, {
      secret: this.env.INTERNAL_SERVICE_JWT_SECRET || this.env.JWT_SECRET,
      audience: this.env.INTERNAL_SERVICE_JWT_AUDIENCE || SERVICE_AUDIENCE,
      issuer: this.env.INTERNAL_SERVICE_JWT_ISSUER || SERVICE_ISSUER,
      clockTolerance: 30,
    });

    if (!payload.sub || !payload.tenantId) {
      throw new UnauthorizedException('service token must include sub and tenantId');
    }
    const headerTenant = request.header('x-tenant-id');
    if (headerTenant && headerTenant !== payload.tenantId) {
      throw new UnauthorizedException('tenant claim mismatch');
    }
    request.serviceAuth = {
      ...payload,
      roles: Array.isArray(payload.roles) ? payload.roles : [],
    };
    return true;
  }

  private extractBearer(request: Request): string | null {
    const header = request.header('authorization') ?? '';
    const prefix = 'bearer ';
    const trimmed = header.trim();
    if (!trimmed.toLowerCase().startsWith(prefix)) return null;
    return trimmed.slice(prefix.length).trim() || null;
  }
}
