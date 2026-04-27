// Auto-logs every mutating HTTP request (POST/PUT/PATCH/DELETE) to the
// audit_events table. Applied globally via AuditModule (Rule 18).
//
// What it captures:
//   action      — "<METHOD> <route>"   (e.g. "PATCH /users/me")
//   resource    — controller class name
//   resource_id — last /:param segment if present
//   user_id     — req.user.sub (populated by JwtAuthGuard)
//   ip_address  — leftmost X-Forwarded-For or socket remote address

import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';
import { AuditService } from './audit.service';

// POST, PUT, PATCH, DELETE are state-changing; GET/HEAD/OPTIONS are safe and
// not audited to avoid log spam.
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly audit: AuditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request & { user?: { sub?: string } }>();
    const res = http.getResponse<Response>();

    if (!MUTATING.has(req.method)) return next.handle();

    const userId = req.user?.sub ?? null;
    const ipAddress = resolveIp(req);
    const action = `${req.method} ${req.route?.path ?? req.path}`;
    const resource = context.getClass().name;
    const resourceId = extractResourceId(req);

    return next.handle().pipe(
      tap({
        next: () => {
          void this.audit.record({
            userId,
            action,
            resource,
            resourceId,
            metadata: { statusCode: res.statusCode },
            ipAddress,
          });
        },
        error: (err: unknown) => {
          const status =
            err && typeof err === 'object' && 'status' in err
              ? (err as { status: number }).status
              : 500;
          void this.audit.record({
            userId,
            action,
            resource,
            resourceId,
            metadata: { statusCode: status, error: String(err) },
            ipAddress,
          });
        },
      }),
    );
  }
}

function resolveIp(req: Request): string | undefined {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  if (Array.isArray(forwarded)) return forwarded[0]?.trim();
  return req.socket?.remoteAddress;
}

// Returns the last route param value as a best-effort resource ID.
// Works for flat routes like /nodes/:id or /users/me.
// Nested routes (e.g. /users/:userId/posts/:postId) will capture :postId,
// which is still useful context in the audit log.
function extractResourceId(req: Request): string | undefined {
  const params = req.params as Record<string, string>;
  const values = Object.values(params);
  return values[values.length - 1] ?? undefined;
}
