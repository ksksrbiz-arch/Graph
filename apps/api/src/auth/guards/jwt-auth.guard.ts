import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Request } from 'express';

/**
 * Phase-0 anon mode:
 *   When the request has no `Authorization` header, accept it and stub
 *   `req.user.sub` with the `userId` query param (default `local`).
 *   This lets the static demo viewer call REST routes without a JWT
 *   while keeping the regular `Authorization: Bearer …` path intact for
 *   authenticated clients.
 *
 *   Phase-1 will flip this off via env (PHASE_0_ALLOW_ANON=false) once
 *   the auth flow is stitched into the SPA.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<Request & { user?: unknown }>();
    const auth = req.headers?.authorization;
    if (!auth) {
      const queryUser = typeof req.query?.userId === 'string' ? req.query.userId : '';
      const headerUser = typeof req.headers['x-user-id'] === 'string'
        ? (req.headers['x-user-id'] as string)
        : '';
      const userId = queryUser || headerUser || 'local';
      (req as Request & { user: { sub: string } }).user = { sub: userId };
      return true;
    }
    return super.canActivate(context);
  }
}
